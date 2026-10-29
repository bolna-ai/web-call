// node --test example/   The test page's server against a stand-in for Bolna's API.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { createKitServer } from "./form-fill-server.js";

const VOICE = { transcriber: { provider: "deepgram" }, synthesizer: { provider: "elevenlabs" }, input: { provider: "plivo" }, output: { provider: "plivo" } };
const AGENTS = [{ id: "agent-1", agent_name: "Voice", tasks: [{ tools_config: VOICE, task_config: { mid_call_events: true } }] }];
const KEY = "bn-test-key-1234";
let bolna;
let kit;
let base;
const bolnaRequests = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  bolna = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    bolnaRequests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    const reply = (status, data) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (req.headers.authorization !== `Bearer ${KEY}`) return reply(401, { message: "bad key" });
    if (req.url === "/agent/all") return reply(200, AGENTS);
    if (req.url === "/browser-agent/tasks") return reply(400, { browser_message: "A form fill needs the form's address." });
    if (req.url === "/web-call/freeswitch-session") return reply(200, { run_id: "run-1", wss_url: "wss://x", sip_username: "u" });
    if (req.url === "/v2/agent" && req.method === "POST") return reply(201, { agent_id: "agent-new" });
    return reply(404, {});
  });
  const bolnaPort = await listen(bolna);
  // The page's own port has to be known before the server starts, for its origin check.
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  kit = createKitServer({ port, apiBase: `http://127.0.0.1:${bolnaPort}`, publicUrl: "https://kit.example.com/browser-kit" });
  await new Promise((resolve) => kit.listen(port, "127.0.0.1", resolve));
});

after(() => {
  kit.close();
  bolna.close();
});

/** A browser: it keeps its cookies, and sends this page's Origin on writes. */
function browser() {
  const jar = new Map();
  return async (method, path, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (method !== "GET") headers.Origin = headers.Origin ?? base;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...value] = pair.split("=");
      jar.set(name, value.join("="));
    }
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: response.status, data, cookies: response.headers.getSetCookie() };
  };
}

test("a pasted key belongs to the browser that pasted it", async () => {
  const mine = browser();
  const theirs = browser();
  await mine("GET", "/api/state");
  await theirs("GET", "/api/state");

  const connected = await mine("POST", "/api/account", { apiKey: KEY });

  assert.equal(connected.status, 200);
  assert.equal(connected.data.browserAgent, "enabled");
  assert.equal((await mine("GET", "/api/agents")).status, 200);
  assert.equal((await theirs("GET", "/api/agents")).status, 401);
});

test("the visitor cookie can't be read by scripts or sent from other sites", async () => {
  const { cookies } = await browser()("GET", "/api/state");
  assert.match(cookies[0], /^kit_sid=[\w-]+; Path=\/browser-kit\/; HttpOnly; SameSite=Strict; Secure$/);
});

test("the key only ever goes to the configured Bolna API", async () => {
  const page = browser();
  bolnaRequests.length = 0;

  await page("POST", "/api/account", { apiKey: KEY, apiBase: "http://169.254.169.254" });

  assert.ok(bolnaRequests.length > 0);
  assert.ok(bolnaRequests.every((r) => r.authorization === `Bearer ${KEY}`));
  assert.equal((await page("GET", "/api/state")).data.apiBase.startsWith("http://127.0.0.1:"), true);
});

test("another site can't use a visitor's key", async () => {
  const page = browser();
  await page("POST", "/api/account", { apiKey: KEY });

  const forged = await page("POST", "/session?agent=agent-1", {}, { Origin: "https://evil.example" });
  const noOrigin = await fetch(base + "/session?agent=agent-1", { method: "POST" });

  assert.equal(forged.status, 403);
  assert.equal(noOrigin.status, 403);
});

test("the demo app's form needs its sign-in", async () => {
  const page = browser();
  assert.match((await page("GET", "/app/apply")).data, /Sign in to continue/);

  await page("POST", "/app/signin", {});

  assert.match((await page("GET", "/app/apply")).data, /Signed in as Asha/);
});

test("option 3 hands Bolna the visitor's app sign-in as a pass, and the app's form as form_url", async () => {
  const page = browser();
  await page("POST", "/api/account", { apiKey: KEY });
  const signedIn = await page("POST", "/app/signin", {});
  const appToken = signedIn.cookies.find((c) => c.startsWith("kit_app=")).split(";")[0].split("=")[1];
  bolnaRequests.length = 0;

  const minted = await page("POST", "/session?agent=agent-1&signin=1", { user_data: { name: "Asha" } });

  assert.equal(minted.status, 200);
  const { body } = bolnaRequests.find((r) => r.path === "/web-call/freeswitch-session");
  assert.deepEqual(body.user_data, { name: "Asha", form_url: "https://kit.example.com/browser-kit/app/apply" });
  assert.deepEqual(body.browser_auth.cookies, [
    {
      name: "kit_app",
      value: appToken,
      domain: "kit.example.com",
      path: "/browser-kit/app",
      secure: true,
      http_only: true,
      same_site: "Lax",
    },
  ]);
});

test("a call without the sign-in carries no pass", async () => {
  const page = browser();
  await page("POST", "/api/account", { apiKey: KEY });
  bolnaRequests.length = 0;

  await page("POST", "/session?agent=agent-1", {});

  const { body } = bolnaRequests.find((r) => r.path === "/web-call/freeswitch-session");
  assert.equal(body.browser_auth, undefined);
  assert.equal((await page("POST", "/session?agent=agent-1&signin=1", {})).status, 400);
});

test("the Symphony form comes as two agents: turn by turn, and all at the end", async () => {
  const page = browser();
  await page("POST", "/api/account", { apiKey: KEY });
  bolnaRequests.length = 0;

  const live = await page("POST", "/api/demo-agents", { kind: "symphony_live", voiceAgentId: "agent-1" });
  const full = await page("POST", "/api/demo-agents", { kind: "symphony", voiceAgentId: "agent-1" });

  assert.equal(live.status, 200);
  assert.equal(live.data.name, "Browser agent demo (Symphony buildathon, turn by turn)");
  assert.equal(full.data.name, "Browser agent demo (Symphony buildathon)");
  const [liveAgent, fullAgent] = bolnaRequests.filter((r) => r.path === "/v2/agent").map((r) => r.body.agent_config);
  const toolsOf = (agent) => agent.tasks[0].tools_config.api_tools;
  assert.equal(toolsOf(liveAgent).tools_params.browser_fill_form.param.live, true);
  assert.ok(toolsOf(liveAgent).tools.some((tool) => tool.name === "browser_add_details"));
  assert.equal(toolsOf(fullAgent).tools_params.browser_fill_form.param.live, undefined);
  assert.ok(!toolsOf(fullAgent).tools.some((tool) => tool.name === "browser_add_details"));
  assert.deepEqual(liveAgent.tasks[0].tools_config.transcriber, VOICE.transcriber);
});

test("the loan agent opens the Netlify loan form turn by turn", async () => {
  const page = browser();
  await page("POST", "/api/account", { apiKey: KEY });
  bolnaRequests.length = 0;

  const created = await page("POST", "/api/demo-agents", { kind: "loan", voiceAgentId: "agent-1" });

  assert.equal(created.status, 200);
  assert.equal(created.data.name, "Browser agent demo (Bolna Bank loan, turn by turn)");
  const { agent_config: agent } = bolnaRequests.find((r) => r.path === "/v2/agent").body;
  const fill = agent.tasks[0].tools_config.api_tools.tools_params.browser_fill_form.param;
  assert.equal(fill.start_url, "https://bolna-bank-loan-demo.netlify.app/");
  assert.equal(fill.live, true);
});
