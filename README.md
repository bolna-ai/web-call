# Bolna Web-Call SDK

Add live AI voice calls to any web app. The SDK connects the browser to your Bolna agent
over **WebRTC** (Opus audio, echo cancellation, TURN fallback) — one class, a few events.

```js
const call = new BolnaWebCall({ sessionUrl: "/api/bolna-session" });
call.on("call-start", () => console.log("agent connected"));
call.on("call-end", ({ reason }) => console.log("ended:", reason));
await call.start();   // from a click handler
```

## Install

**npm**

```bash
npm install @bolna/web-call
```

```js
import { BolnaWebCall } from "@bolna/web-call";
```

**CDN / plain `<script>`**

```html
<script src="https://cdn.jsdelivr.net/gh/bolna-ai/web-call@v2.0.0/dist/bolna-web-call.min.js"></script>
<script>
  const call = new BolnaWebCall({ sessionUrl: "/api/bolna-session" });
</script>
```

## The security model (read this first)

Your `bn-` API key must **never** ship in a web page — anyone could read it and place calls
on your account. Instead, the browser gets a **short-lived, single-use call session**:

```
browser ──POST /api/bolna-session──▶ YOUR backend ──bn- key──▶ Bolna mint
browser ◀───────── ephemeral session (SIP creds ~120s TTL, TURN creds) ─────────┘
```

Your backend endpoint is ~10 lines — call Bolna's mint and return the JSON as-is:

```js
// e.g. Express — protect this route with YOUR user auth
app.post("/api/bolna-session", async (req, res) => {
  const r = await fetch("https://api.bolna.ai/web-call/freeswitch-session", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BOLNA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: process.env.BOLNA_AGENT_ID }),
  });
  res.status(r.status).json(await r.json());
});
```

A runnable version is in [`example/server-example.js`](example/server-example.js), and a full
demo page in [`example/sip-example.html`](example/sip-example.html).

The SDK deliberately has **no `apiKey` option**. The minted session expires in ~2 minutes and
its SIP credential is consumed by the first call — leaking one is worth almost nothing.

## API

### `new BolnaWebCall(options)`

Provide **exactly one** session source:

| Option | Type | Use when |
|---|---|---|
| `sessionUrl` | `string` | You have a backend endpoint (POST, no body) returning the mint JSON — the standard setup |
| `getSession` | `() => Promise<Session>` | You need custom fetch logic (auth headers, retries, framework client) |
| `session` | `Session` | You already fetched a session this instant (it expires in ~120s) |

Optional:

| Option | Default | Purpose |
|---|---|---|
| `audio` | AEC/NS/AGC on | `MediaTrackConstraints` for the mic |
| `iceTransportPolicy` | `"all"` | `"relay"` forces TURN (restrictive networks/testing) |
| `audioElement` | hidden element | Play the agent through your own `<audio>` |
| `debug` | `false` | Verbose logging |

### Methods

| Method | Description |
|---|---|
| `await call.start()` | Mint → mic permission → connect. Resolves when the agent answers. **Call from a user gesture** so audio is allowed to play. |
| `await call.stop()` | Hang up + release everything. Idempotent. |
| `call.setMuted(bool)` / `call.isMuted()` | Toggle the mic without ending the call |
| `call.getState()` | `"idle" \| "connecting" \| "ringing" \| "active" \| "ended"` |
| `call.getRunId()` | The call's execution id (matches your call-history / webhooks) |

### Events — `call.on(event, handler)` / `off` / `once`

| Event | Payload | Fires when |
|---|---|---|
| `state-change` | `CallState` | Any state transition |
| `media-permission` | — | Mic permission granted |
| `call-start` | — | Agent answered, audio flowing |
| `call-end` | `{ reason }` | `"local-hangup"`, `"remote-hangup"`, or `"failed"` |
| `error` | `{ code, message, scope?, cause? }` | See error table |
| `volume-level` | `0..1` | Agent audio level, ~10×/sec (drive a meter/avatar) |

### Error codes

| `code` | Meaning | Typical handling |
|---|---|---|
| `mint_failed` | Your session endpoint failed | Check your backend / network |
| `at_capacity` | Concurrent-call limit hit (`scope`: `global`/`customer`) | Show "all lines busy, retry shortly" |
| `microphone_denied` | User blocked the mic | Show mic-permission help |
| `connect_failed` | Network/server unreachable or setup timeout | Retry with a fresh `start()` |
| `call_rejected` | Server declined the call | Check agent id / session freshness |
| `autoplay_blocked` | Browser blocked audio playback | Call `start()` from a click handler |
| `already_active` | `start()` while a call is live | One call per instance at a time |

## Behavior notes

- **One call at a time** per instance — a second `start()` rejects instead of double-dialing.
- **Sessions are fetched per call**, inside `start()`, so the short credential TTL can't lapse.
  Nothing is ever written to `localStorage`.
- **Echo cancellation** is on by default (recommended: leave it on; headphones for best results).
- **Tab close / navigation** hangs the call up automatically (`pagehide`), so abandoned calls
  release capacity immediately.
- All media is **DTLS-SRTP encrypted**; TURN relay credentials are per-call and time-boxed.

## Legacy library (v1)

`bolna-webcall-library.js` (the v1.0.x direct-WebSocket library) remains in this repo unchanged
— existing jsDelivr pins keep working. New integrations should use the v2 SDK above: better
audio (Opus + jitter buffer vs raw 16k PCM), standard WebRTC, and no key-handling foot-guns.

## Development

```bash
npm install
npm run build      # dist/index.mjs (+ d.ts) and dist/bolna-web-call.min.js
npm run typecheck
```

Demo: `BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... node example/server-example.js`, serve the repo
(`python3 -m http.server 8081`), open `http://localhost:8081/example/sip-example.html`.
