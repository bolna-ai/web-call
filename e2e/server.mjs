// Minimal static file + fake session-mint server for the Playwright e2e tests.
// Serves the real repo root (so /dist/bolna-web-call.min.js is the actual built CDN bundle)
// plus a handful of /session/<mode> routes standing in for Bolna's real mint endpoint —
// no live Bolna backend or credentials involved.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
};

function fakeSession(overrides = {}) {
  return {
    run_id: "run_e2e_" + Math.random().toString(36).slice(2),
    agent_id: "agent_e2e",
    sip_username: "u_e2e",
    sip_password: "p_e2e",
    sip_domain: "sip.invalid",
    // deliberately unroutable — no live SIP/WebRTC peer is involved in these e2e tests,
    // so a real UserAgent.start() will fail to connect (that's expected and unasserted)
    wss_url: "wss://sip.invalid.example/ws",
    sip_register: false,
    expires_in: 120,
    ice_servers: [],
    ...overrides,
  };
}

const routes = {
  "/session/valid": () => ({ status: 200, body: fakeSession() }),
  "/session/error-429": () => ({ status: 429, body: { scope: "customer" } }),
  "/session/error-500": () => ({ status: 500, body: { message: "internal error" } }),
  "/session/malformed": () => ({ status: 200, body: { agent_id: "agent_e2e" } }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && routes[url.pathname]) {
    const { status, body } = routes[url.pathname]();
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // static file serving from the repo root
  let filePath = path.join(ROOT, decodeURIComponent(url.pathname));
  if (url.pathname === "/") filePath = path.join(ROOT, "e2e", "fixtures", "page.html");
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`e2e fixture server on http://localhost:${PORT}`);
});
