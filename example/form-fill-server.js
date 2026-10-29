// Test page for the browser agent on a web call: paste your API key, create the demo agents, and try three ways the
// agent fills a form while you talk:
//   1. the Symphony buildathon form, filled by Bolna's cloud browser (a yes sends a real application);
//   2. a form on this page itself, filled live in your own tab through the SDK's attachPage;
//   3. a demo app's form behind a sign-in, which the cloud browser opens already signed in with a pass this server
//      (acting as the app's server) hands Bolna when the call starts.
//
// Run from the repo root after `npm run build`:  node example/form-fill-server.js   then open http://localhost:8787
//
// Each visitor's key stays in this server's memory, tied to that browser by a cookie, and is dropped after two idle
// hours; it is never written to disk, logged or put in a URL. The Bolna API base is fixed by KIT_API_BASE, so the
// server can't be pointed anywhere else.
//
// Env: KIT_PORT (8787), KIT_HOST (127.0.0.1), KIT_API_BASE (https://api-topaz.bolna.ai), KIT_PUBLIC_URL (this page's
// public address, such as https://api-topaz.bolna.ai/browser-kit; default http://localhost:KIT_PORT) and
// AGENT_CONFIG_DIR (the demo agent configs; default ../dashboard-backend/scripts/browser_agent).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IDLE_SECONDS = 2 * 60 * 60;
const MAX_VISITORS = 500;
const MAX_BODY_BYTES = 64 * 1024;
const DEMO_AGENTS = {
  symphony: { file: "demo_symphony_agent.json", name: "Browser agent demo (Symphony buildathon)" },
  // The same form turn by turn: the browser opens it as the call starts and types each answer as it's given.
  symphony_live: {
    file: "demo_symphony_live_agent.json",
    name: "Browser agent demo (Symphony buildathon, turn by turn)",
  },
  page: { file: "demo_page_form_agent.json", name: "Browser agent demo (in-tab form)" },
  // Fills whatever form the call's form_url variable names; option 3 points it at the demo app.
  app: { file: "demo_any_form_agent.json", name: "Browser agent demo (signed-in app)" },
  // The made-up bank's multi-screen loan form on Netlify, filled turn by turn with a yes per screen.
  loan: { file: "demo_loan_agent.json", name: "Browser agent demo (Bolna Bank loan, turn by turn)" },
};
// The voice settings a demo agent copies from one of your agents.
const VOICE_KEYS = ["transcriber", "synthesizer", "input", "output"];
const STATIC_FILES = {
  "/": ["form-fill.html", "text/html; charset=utf-8"],
  "/dist/bolna-web-call.min.js": ["../dist/bolna-web-call.min.js", "text/javascript; charset=utf-8"],
  "/dist/bolna-web-call.min.js.map": ["../dist/bolna-web-call.min.js.map", "application/json"],
};
const APP_COOKIE = "kit_app";
const VISITOR_COOKIE = "kit_sid";

function token() {
  return randomBytes(24).toString("base64url");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function cookiesOf(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) cookies[name] = rest.join("=");
  }
  return cookies;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return JSON.parse(text);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
}

function errorText(data, status) {
  const detail = data && (data.message || data.detail || data.browser_message || data.error);
  return `HTTP ${status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`;
}

/** The test page's server. Returns an http.Server; call listen() on it. */
export function createKitServer({
  port = 8787,
  apiBase = "https://api-topaz.bolna.ai",
  publicUrl = `http://localhost:${port}`,
  agentConfigDir = path.join(HERE, "../../dashboard-backend/scripts/browser_agent"),
  idleSeconds = IDLE_SECONDS,
} = {}) {
  apiBase = apiBase.replace(/\/+$/, "");
  const site = new URL(publicUrl.replace(/\/+$/, "") + "/");
  const basePath = site.pathname.replace(/\/+$/, "");
  const secure = site.protocol === "https:";
  const allowedHosts = new Set([site.host, `localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = new Set([site.origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  // Visitor id → { apiKey, lastSeen, appToken }. App sign-in token → visitor id.
  const visitors = new Map();
  const appSessions = new Map();
  const appSubmissions = [];

  function cookie(name, value, cookiePath, sameSite) {
    return `${name}=${value}; Path=${cookiePath}; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
  }

  function sweep(now = Date.now()) {
    for (const [id, visitor] of visitors) {
      if (now - visitor.lastSeen > idleSeconds * 1000) {
        visitors.delete(id);
        if (visitor.appToken) appSessions.delete(visitor.appToken);
      }
    }
    while (visitors.size > MAX_VISITORS) visitors.delete(visitors.keys().next().value);
  }

  /** This browser's visitor record; a new one (and its cookie) when it has none or it expired. */
  function visitorOf(req, res) {
    sweep();
    const id = cookiesOf(req)[VISITOR_COOKIE];
    let visitor = id && visitors.get(id);
    if (!visitor) {
      const newId = token();
      visitor = { id: newId, apiKey: "", lastSeen: Date.now(), appToken: "" };
      visitors.set(newId, visitor);
      res.setHeader("Set-Cookie", cookie(VISITOR_COOKIE, newId, `${basePath}/`, "Strict"));
    }
    visitor.lastSeen = Date.now();
    return visitor;
  }

  // Only this page may use a key: other sites in your browser, and DNS rebinding, get a 403.
  function fromThisPage(req) {
    if (!allowedHosts.has(req.headers.host)) return false;
    const origin = req.headers.origin;
    return origin ? allowedOrigins.has(origin) : req.method === "GET" || req.method === "HEAD";
  }

  async function bolna(apiKey, method, apiPath, body) {
    const response = await fetch(`${apiBase}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    return { status: response.status, ok: response.ok, data };
  }

  async function listAgents(apiKey) {
    const { ok, status, data } = await bolna(apiKey, "GET", "/agent/all");
    if (!ok || !Array.isArray(data)) throw new Error(`Couldn't list your agents (${errorText(data, status)})`);
    return data.map((agent) => ({
      id: agent.id,
      name: agent.agent_name || "(no name)",
      voice: VOICE_KEYS.every((key) => agent.tasks?.[0]?.tools_config?.[key]),
      hearsUpdates: Boolean(agent.tasks?.[0]?.task_config?.mid_call_events),
      tasks: agent.tasks,
    }));
  }

  // A form fill with no form address: 403 means the browser agent isn't enabled for this account; once it is, the
  // request fails on the missing address instead (400) and nothing is queued.
  async function browserAgentEnabled(apiKey) {
    const { status } = await bolna(apiKey, "POST", "/browser-agent/tasks", { task: "access check", mode: "form_fill" });
    if (status === 403) return "not enabled";
    if (status === 400) return "enabled";
    return `unknown (HTTP ${status})`;
  }

  async function createDemoAgent(apiKey, kind, voiceAgentId) {
    const demo = DEMO_AGENTS[kind];
    if (!demo) throw new Error("Unknown demo agent.");
    const voiceAgent = (await listAgents(apiKey)).find((agent) => agent.id === voiceAgentId);
    if (!voiceAgent) throw new Error("Pick the agent whose voice to copy.");
    const raw = await readFile(path.join(agentConfigDir, demo.file), "utf8").catch(() => {
      throw new Error(`Can't read ${demo.file}; set AGENT_CONFIG_DIR.`);
    });
    const payload = JSON.parse(raw.replaceAll("__BASE_URL__", apiBase).replaceAll("__API_KEY__", apiKey));
    const config = payload.agent_config;
    const tools = config.tasks[0].tools_config;
    for (const key of VOICE_KEYS) {
      const value = voiceAgent.tasks?.[0]?.tools_config?.[key];
      if (!value) throw new Error(`"${voiceAgent.name}" has no ${key}; pick a regular (not speech-to-speech) voice agent.`);
      tools[key] = value;
    }
    config.agent_name = demo.name;
    const { ok, status, data } = await bolna(apiKey, "POST", "/v2/agent", payload);
    if (!ok) throw new Error(`Couldn't create the agent (${errorText(data, status)})`);
    return { id: data.agent_id, name: demo.name };
  }

  /** The web call for this visitor's agent. Option 3 hands Bolna the visitor's demo-app sign-in as a pass, the way
   *  an app's own server would, and points the agent at the app's form. */
  async function mintSession(visitor, agentId, userData, signedIn) {
    const body = { agent_id: agentId };
    if (userData) body.user_data = userData;
    if (signedIn) {
      if (!visitor.appToken) throw Object.assign(new Error("Sign in to the demo app first."), { status: 400 });
      body.user_data = { ...(userData || {}), form_url: `${site.origin}${basePath}/app/apply` };
      body.browser_auth = {
        cookies: [
          {
            name: APP_COOKIE,
            value: visitor.appToken,
            domain: site.hostname,
            path: `${basePath}/app`,
            secure,
            http_only: true,
            same_site: "Lax",
          },
        ],
      };
    }
    return bolna(visitor.apiKey, "POST", "/web-call/freeswitch-session", body);
  }

  async function handleApi(req, res, url, visitor) {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, {
        apiBase,
        connected: Boolean(visitor.apiKey),
        keyHint: visitor.apiKey ? `${visitor.apiKey.slice(0, 3)}…${visitor.apiKey.slice(-4)}` : "",
        appUser: visitor.appToken ? "Asha (demo)" : "",
        appFormUrl: `${basePath}/app/apply`,
      });
    }
    if (url.pathname === "/api/account" && req.method === "POST") {
      const { apiKey } = await readJson(req);
      if (!apiKey || typeof apiKey !== "string") return sendJson(res, 400, { message: "Paste your API key." });
      try {
        const agents = await listAgents(apiKey.trim());
        visitor.apiKey = apiKey.trim();
        return sendJson(res, 200, {
          agents: agents.map(({ tasks, ...agent }) => agent),
          browserAgent: await browserAgentEnabled(visitor.apiKey),
        });
      } catch (err) {
        return sendJson(res, 400, { message: err.message });
      }
    }
    if (url.pathname === "/api/demo-submit" && req.method === "POST") {
      // The in-tab form's own server: it takes the application and answers with a reference number.
      const fields = await readJson(req);
      return sendJson(res, 200, { reference: `TAB-${1000 + Math.floor(Math.random() * 9000)}`, fields: Object.keys(fields).length });
    }
    if (!visitor.apiKey) return sendJson(res, 401, { message: "Paste your API key and connect first." });
    if (url.pathname === "/api/agents" && req.method === "GET") {
      const agents = await listAgents(visitor.apiKey);
      return sendJson(res, 200, { agents: agents.map(({ tasks, ...agent }) => agent) });
    }
    if (url.pathname === "/api/demo-agents" && req.method === "POST") {
      const { kind, voiceAgentId } = await readJson(req);
      return sendJson(res, 200, await createDemoAgent(visitor.apiKey, kind, voiceAgentId));
    }
    if (url.pathname === "/api/app-submissions" && req.method === "GET") {
      const mine = appSubmissions.filter((s) => s.visitorId === visitor.id).map(({ visitorId, ...s }) => s);
      return sendJson(res, 200, { submissions: mine });
    }
    return sendJson(res, 404, { message: "Not found" });
  }

  // The demo app: a sign-in, and an application form only a signed-in browser sees.
  async function handleApp(req, res, url, visitor) {
    if (url.pathname === "/app/signin" && req.method === "POST") {
      if (visitor.appToken) appSessions.delete(visitor.appToken);
      visitor.appToken = token();
      appSessions.set(visitor.appToken, visitor.id);
      res.setHeader("Set-Cookie", [
        res.getHeader("Set-Cookie"),
        cookie(APP_COOKIE, visitor.appToken, `${basePath}/app`, "Lax"),
      ].flat().filter(Boolean));
      return sendJson(res, 200, { appUser: "Asha (demo)" });
    }
    const appToken = cookiesOf(req)[APP_COOKIE];
    const ownerId = appToken && appSessions.get(appToken);
    if (!ownerId) return sendHtml(res, 401, APP_SIGNIN_PAGE);
    if (url.pathname === "/app/apply" && req.method === "GET") return sendHtml(res, 200, APP_FORM_PAGE);
    if (url.pathname === "/app/submit" && req.method === "POST") {
      const fields = await readJson(req);
      const reference = `APP-${1041 + appSubmissions.length}`;
      appSubmissions.push({ visitorId: ownerId, at: new Date().toISOString(), reference, fields });
      return sendHtml(
        res,
        200,
        `<!doctype html><html lang="en"><body><h1>Application received</h1><p>Your reference is ${reference}.</p></body></html>`,
      );
    }
    return sendHtml(res, 404, "<p>Not found</p>");
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://kit.local");
    if (!fromThisPage(req)) return sendJson(res, 403, { message: "Open this page from its own address." });
    // The demo app's pages are what the cloud browser opens: they know it only by its sign-in, not as a visitor.
    const appPage = url.pathname.startsWith("/app/") && url.pathname !== "/app/signin";
    const visitor = appPage ? null : visitorOf(req, res);
    try {
      if ((req.method === "GET" || req.method === "HEAD") && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        try {
          return res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" }).end(await readFile(path.join(HERE, file)));
        } catch {
          return res.writeHead(404).end(`Missing ${file}: run npm run build from the repo root.`);
        }
      }
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url, visitor);
      if (url.pathname.startsWith("/app/")) return await handleApp(req, res, url, visitor);
      if (req.method === "POST" && url.pathname === "/session") {
        const agentId = url.searchParams.get("agent");
        if (!visitor.apiKey || !agentId) return sendJson(res, 400, { message: "Connect and pick an agent first." });
        // The SDK sends {"user_data": {...}}; Bolna fills those variables into the prompt and welcome message.
        const { user_data: userData } = await readJson(req);
        const { status, data } = await mintSession(visitor, agentId, userData, url.searchParams.get("signin") === "1");
        return sendJson(res, status, data);
      }
    } catch (err) {
      return sendJson(res, err.status || 502, { message: err.message || "request failed" });
    }
    res.writeHead(404).end();
  });
}

const APP_STYLE = `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#18181b;background:#fff}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:14px}input,textarea{width:100%;box-sizing:border-box;padding:8px}
button{margin-top:14px;padding:10px 16px}</style>`;

// What the cloud browser sees without the pass: a sign-in, which it reports as a blocker instead of filling.
const APP_SIGNIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title>${APP_STYLE}</head>
<body><h1>Sign in to continue</h1>
<form><label>Email <input type="email" name="login_email"></label><label>Password <input type="password" name="login_password"></label>
<button type="button">Sign in</button></form></body></html>`;

const APP_FORM_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo app: apply</title>${APP_STYLE}</head>
<body><p>Signed in as Asha (demo)</p><h1>Apply to the demo programme</h1>
<form method="post" action="submit">
<label for="full_name">Full name</label><input id="full_name" name="full_name" required>
<label for="email">Email</label><input id="email" type="email" name="email" required>
<label for="phone">Phone</label><input id="phone" type="tel" name="phone">
<label for="company">Company</label><input id="company" name="company">
<label for="why">Why do you want to join?</label><textarea id="why" name="why"></textarea>
<button>Submit application</button>
</form></body></html>`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.KIT_PORT || 8787);
  const host = process.env.KIT_HOST || "127.0.0.1";
  createKitServer({
    port,
    apiBase: process.env.KIT_API_BASE || undefined,
    publicUrl: process.env.KIT_PUBLIC_URL || undefined,
    agentConfigDir: process.env.AGENT_CONFIG_DIR || undefined,
  }).listen(port, host, () => console.log(`browser agent test page on http://${host}:${port}`));
}
