# Bolna Web-Call SDK

[![npm](https://img.shields.io/npm/v/@bolna/web-call)](https://www.npmjs.com/package/@bolna/web-call)

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
<script src="https://cdn.jsdelivr.net/gh/bolna-ai/web-call@v3.1.0/dist/bolna-web-call.min.js"></script>
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
| `userData` | — | Dynamic variables for the call — substituted into the agent's prompt + welcome message (same as telephony `/call`'s `user_data`). Sent as `{"user_data": ...}` in the POST body to `sessionUrl`; forward it yourself if you use `getSession`/`session` |
| `audio` | AEC/NS/AGC on | `MediaTrackConstraints` for the mic |
| `iceTransportPolicy` | `"all"` | `"relay"` forces TURN (restrictive networks/testing) |
| `audioElement` | hidden element | Play the agent through your own `<audio>` |
| `debug` | `false` | Verbose logging |

### Methods

| Method | Description |
|---|---|
| `await call.start(opts?)` | Mint → mic permission → connect. Resolves when the agent answers. **Call from a user gesture** so audio is allowed to play. `opts.userData` overrides the constructor's `userData` for this call. |
| `await call.stop()` | Hang up + release everything. Idempotent. |
| `call.setMuted(bool)` / `call.isMuted()` | Toggle the mic without ending the call |
| `call.getState()` | `"idle" \| "connecting" \| "ringing" \| "active" \| "ended"` |
| `call.getRunId()` | The call's execution id (matches your call-history / webhooks) |
| `call.getBrowserView()` | The latest view of the browser the agent drives, or `null` (see [Browser view](#browser-view)) |
| `call.attachPage(form, opts?)` | Let the agent fill this form on your page during calls (see [Fill a form on your page](#fill-a-form-on-your-page)) |

### Events — `call.on(event, handler)` / `off` / `once`

| Event | Payload | Fires when |
|---|---|---|
| `state-change` | `CallState` | Any state transition |
| `media-permission` | — | Mic permission granted |
| `call-start` | — | Agent answered, audio flowing |
| `call-end` | `{ reason }` | `"local-hangup"`, `"remote-hangup"`, or `"failed"` |
| `error` | `{ code, message, scope?, cause? }` | See error table |
| `volume-level` | `0..1` | Agent audio level, ~10×/sec (drive a meter/avatar) |
| `browser-ready` | — | The call is active and its agent can drive a browser |
| `browser-update` | `BrowserView` | The browser moved on: a step, a question for the caller, a read-back, its outcome |
| `browser-error` | `{ code, message }` | Following the browser hit a problem; never ends the call |
| `page-update` | `{ state, field?, detail? }` | A form connected with `attachPage` moved on |
| `page-error` | `{ code, message }` | Filling a form connected with `attachPage` hit a problem; never ends the call |

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

## Dynamic variables (`userData`)

Pass per-call variables and they're substituted into the agent's prompt and welcome message —
identical to `user_data` on the telephony `/call` API. If the agent prompt says
`Hello {name}, calling about {order_id}`:

```js
const call = new BolnaWebCall({ sessionUrl: "/api/bolna-session" });
await call.start({ userData: { name: "Asha", order_id: "ORD-42" } });
// or set it once for every call: new BolnaWebCall({ sessionUrl, userData: {...} })
```

How it flows depends on your session mode:

- **`sessionUrl`** — the SDK POSTs `{"user_data": {...}}` to your endpoint. Your proxy must
  forward that field to `POST /web-call/freeswitch-session` (see `example/server-example.js`,
  it already does).
- **`getSession` / `session`** — you own the mint request, so the SDK can't inject anything:
  include `user_data` in your own POST body or the variables silently won't reach the agent.

```js
// getSession mode — forward it yourself:
new BolnaWebCall({
  getSession: async () => {
    const res = await fetch("/api/bolna-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_data: { name: "Asha" } }),
    });
    return res.json();
  },
});
```

Limits: `user_data` must be a JSON object, max 50 KB (the mint returns 400 above that).
Values are also stored on the call record (`call_details.recipient_data`) and shown in
call history — don't put secrets in them.

## Browser view

When the agent can drive a browser during the call (filling in a form on a website, or looking something up), the
mint's session carries a `browser_view` key, and the SDK follows the browser once the call is active. Your proxy
must return the mint JSON as-is (`example/server-example.js` does) for the key to reach the SDK.

Drop in the ready-made panel:

```js
// npm: import { BolnaWebCall, mountBrowserPanel } from "@bolna/web-call";
// CDN: use BolnaWebCall.mountBrowserPanel
let removePanel = null;
call.on("browser-ready", () => {
  removePanel?.(); // a reused instance gets a fresh panel per call
  removePanel = mountBrowserPanel(call, document.getElementById("browser"));
});
```

It shows:

- what the browser is doing;
- any question or read-back the caller should answer;
- the latest screenshot;
- the step lines, such as "Typed into 'E-mail address'" (never the values typed).

Page text always goes in as text, never as HTML. `mountBrowserPanel` returns a function that removes the panel.
Theme it with the `--bolna-bp-bg`, `-fg`, `-muted`, `-border`, `-accent` and `-radius` CSS variables, set on
`.bolna-bp` or any ancestor. Inside a shadow root, the panel puts its styles in that root.

Or build your own UI from `browser-update`:

| Field | Meaning |
|---|---|
| `status` | `queued`, `running`, `waiting`, `done`, `failed` or `stopped` |
| `kind` | `form_fill`, `lookup`, or `page_fill` (a form on your own page, below; no screenshots) |
| `awaiting` | While `waiting`: `answer` (show `question`) or `confirmation` (show `confirm_summary`, the filled-in form read from the page) |
| `progress`, `recent_actions` | What it is doing now, and its latest step lines |
| `submitted`, `reference` | A form fill's outcome. `submitted` is `true` only when Bolna saw the form submitted after the caller confirmed |
| `answer`, `error` | A lookup's answer or why a form fill stopped short; why it failed |
| `screenshot_url` | Object URL of the latest screenshot, or `null` |

The caller answers by voice, and the agent hands the answer to the browser. How the SDK polls:

- about every 1.5 s, pausing while the tab is hidden and backing off when a request fails;
- after the call ends, it keeps looking for up to 15 s, until the browser's outcome shows;
- `getBrowserView()` keeps the last view, screenshot included, until the next `start()`.

`browser-error` never ends the call. `view_expired` means updates stopped; `view_unavailable` means a request failed
and the SDK keeps retrying.

### Signed-in forms

For a form behind your app's sign-in, your **server** can hand Bolna a short-lived pass when it mints the call, so
the browser opens the form already signed in. Add `browser_auth` to the `/web-call/freeswitch-session` body:

```json
{
  "agent_id": "…",
  "user_data": { "form_url": "https://app.example.com/apply" },
  "browser_auth": {
    "cookies": [{ "name": "session", "value": "<a short-lived session for this user>", "domain": "app.example.com", "path": "/" }]
  }
}
```

- Send it from your server only, never from the browser. Issue a session just for this call, not the user's own.
- Only cookies for the form's own site are used; any other domain, a parent domain included, is dropped.
- Bolna keeps the pass for the length of the call. The browser loads it before the form opens and then deletes it,
  and it never reaches a log, the view or the agent.
- Each cookie takes `name`, `value` and `domain`, plus optional `path` (`/`), `secure` (`true`), `http_only`
  (`true`), `same_site` (`Lax`) and `expires` (Unix seconds). At most 20 cookies.

## Fill a form on your page

The agent can also fill a form on **your own page** while the caller talks: each value types into the field as the
caller says it, the caller can type too, and the form is submitted only after the caller says yes to a read-back of
what the page holds. It runs in the caller's own tab, so pages behind your sign-in work as they are. The agent needs
mid-call events on and the page-fill tools (see the `demo_page_form_agent.json` demo agent).

```js
const page = call.attachPage(document.querySelector("#apply"));

// Your form's own submit handler, after the caller's yes:
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { reference } = await sendApplication();
    page.reportSubmitted(reference);
  } catch (err) {
    page.reportFailed(err.message);
  }
});
```

Or pass `submit` and let the SDK send it: `call.attachPage(form, { submit: async (values) => ({ reference }) })`. A
form that leaves the page when it submits needs `submit`, since the page can't report back once it has gone.

What the agent sees:

- **The fields.** Inputs, text areas, selects, radio groups, tick boxes, and rows of option buttons you mark with
  `data-bolna-field="name"` (each button's text, or `data-bolna-option`, is an option; the pressed one carries
  `aria-pressed="true"`).
- **Their names.** `data-bolna-field`, else the element's `name`, else its label. The label comes from
  `data-bolna-label`, `aria-label`, `<label>` or the placeholder.
- **Fields that appear or go.** A choice that reveals more fields is picked up on its own.
- **Never read or filled:** passwords, payment cards, one-time codes, hidden fields, and anything inside
  `data-bolna-ignore`.

Before submitting, the SDK checks the form still holds what the caller confirmed, and that the browser's own
validation passes; otherwise the agent hears why and reads the form back again. Follow it with `page-update`
(`connecting`, `ready`, `typing` with the field's label, `confirming`, `submitting`, `submitted`, `not_submitted`,
`stopped`) and `page-error` (`page_unavailable`: the agent can't fill pages; `page_failed`: a request failed and the
SDK retries). `detach()` stops filling that form.

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
— existing jsDelivr pins keep working. New integrations should use the v3 SDK above: better
audio (Opus + jitter buffer vs raw 16k PCM), standard WebRTC, and no key-handling foot-guns.

## Development

```bash
npm install
npm run build      # dist/index.js (+ d.ts) and dist/bolna-web-call.min.js
npm run typecheck
npm test           # unit tests (vitest)
npm run test:e2e   # browser tests (playwright)
```

Demo: `BOLNA_API_KEY=bn-... BOLNA_AGENT_ID=... node example/server-example.js`, serve the repo
(`python3 -m http.server 8081`), open `http://localhost:8081/example/sip-example.html`.

Browser agent test page: `node example/form-fill-server.js`, then open `http://localhost:8787`. Paste your key, create
the demo agents, and call: Bolna's browser on the Symphony form, a form on the page filled in your tab, a demo
app's signed-in form, and the Bolna Bank loan form. Its env vars are at the top of the file; `node --test
example/form-fill-server.test.mjs` runs its tests.

Against production, for an org with the browser agent turned on (run `npm run build` first; the page serves `dist/`):

```bash
KIT_API_BASE=https://api.bolna.ai node example/form-fill-server.js
```

Then open `http://localhost:8787`, paste a production API key, press "Create loan agent" in card 4 and call. The
signed-in app (card 3) needs the page at a public address: production's browser only opens public sites, never
`localhost`.

## License

MIT — see [LICENSE](LICENSE).
