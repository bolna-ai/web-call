// The canonical SAFE integration: your bn- API key lives HERE (server-side), never in
// the browser. The page POSTs /session; this proxy mints a short-lived per-call session
// from Bolna and returns it. Run:  BOLNA_API_KEY=bn-... node server-example.js
import http from "node:http";

const API_KEY = process.env.BOLNA_API_KEY;
const AGENT_ID = process.env.BOLNA_AGENT_ID || "";
const API_BASE = process.env.BOLNA_API_BASE || "https://api.bolna.ai";
const PORT = Number(process.env.PORT || 8787);

if (!API_KEY) {
  console.error("Set BOLNA_API_KEY (your bn- key) in the environment.");
  process.exit(1);
}

http
  .createServer(async (req, res) => {
    // In production, restrict this to your own origin instead of "*",
    // and add YOUR user auth here so only signed-in users can start calls.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "POST" || req.url !== "/session") return res.writeHead(404).end();

    try {
      const upstream = await fetch(`${API_BASE}/web-call/freeswitch-session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: AGENT_ID }),
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, { "Content-Type": "application/json" }).end(body);
    } catch (err) {
      console.error("mint failed:", err);
      res.writeHead(502).end(JSON.stringify({ message: "session mint failed" }));
    }
  })
  .listen(PORT, () => console.log(`session proxy on http://localhost:${PORT}/session (agent ${AGENT_ID || "UNSET"})`));
