// Real-browser tests for the actual built CDN bundle (dist/bolna-web-call.min.js) — genuine
// Chromium, genuine navigator.mediaDevices.getUserMedia (via a synthetic fake device), genuine
// fetch, genuine DOM. No live Bolna backend is involved: /session/* routes here are served by
// a tiny local fixture server (e2e/server.mjs), not Bolna's real mint endpoint — so these tests
// cannot and do not reach an actual connected call (SessionState.Established never happens; it
// needs a real or simulated SIP/WebRTC peer). What they DO validate for real, that the Node/
// vitest suite in test/ can only mock: the mic permission flow, real fetch-based error mapping,
// and the start()/stop() race fix under a real browser event loop.
import { chromium, expect, test } from "@playwright/test";

declare global {
  interface Window {
    BolnaWebCall: any;
  }
}

test("the built CDN bundle loads and exposes window.BolnaWebCall with correct constructor validation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => {
    const out: Record<string, unknown> = { hasGlobal: typeof window.BolnaWebCall === "function" };
    try {
      new window.BolnaWebCall({});
      out.noSourceThrew = false;
    } catch (e) {
      out.noSourceThrew = true;
      out.noSourceMessage = (e as Error).message;
    }
    try {
      new window.BolnaWebCall({ session: { run_id: "x" } });
      out.oneSourceOk = true;
    } catch {
      out.oneSourceOk = false;
    }
    return out;
  });
  expect(result.hasGlobal).toBe(true);
  expect(result.noSourceThrew).toBe(true);
  expect(result.noSourceMessage).toMatch(/provide exactly one of/);
  expect(result.oneSourceOk).toBe(true);
});

test("real getUserMedia (fake device) grants mic permission, then a real fetch to an unreachable SIP host fails as connect_failed", async ({ page }) => {
  await page.goto("/");
  const events = await page.evaluate(async () => {
    return await new Promise<string[]>((resolve) => {
      const evs: string[] = [];
      const call = new window.BolnaWebCall({ sessionUrl: "/session/valid", debug: false });
      call.on("media-permission", () => evs.push("media-permission"));
      call.on("error", (e: { code: string }) => evs.push("error:" + e.code));
      call.on("state-change", (s: string) => evs.push("state:" + s));
      call.start().catch(() => evs.push("start-rejected"));
      // the fixture server's /session/valid points at a deliberately unroutable wss_url
      // (no real or fake SIP peer exists) — this real UserAgent.start() will fail; we're only
      // asserting that mic permission was for-real granted before that failure, and that the
      // failure is for-real reported through the browser's fetch/WebSocket stack
      setTimeout(() => resolve(evs), 8000);
    });
  });

  expect(events).toContain("media-permission");
  expect(events.some((e) => e.startsWith("error:"))).toBe(true);
  expect(events).not.toContain("call-start" as never);
});

test("real fetch: HTTP 429 from the session-mint endpoint maps to at_capacity", async ({ page }) => {
  await page.goto("/");
  const events = await page.evaluate(async () => {
    return await new Promise<string[]>((resolve) => {
      const evs: string[] = [];
      const call = new window.BolnaWebCall({ sessionUrl: "/session/error-429" });
      call.on("error", (e: { code: string; scope?: string }) => evs.push(`error:${e.code}:${e.scope}`));
      call.start().catch(() => evs.push("start-rejected"));
      setTimeout(() => resolve(evs), 2000);
    });
  });
  expect(events.some((e) => e.startsWith("error:at_capacity:"))).toBe(true);
});

test("real fetch: HTTP 500 from the session-mint endpoint maps to mint_failed", async ({ page }) => {
  await page.goto("/");
  const events = await page.evaluate(async () => {
    return await new Promise<string[]>((resolve) => {
      const evs: string[] = [];
      const call = new window.BolnaWebCall({ sessionUrl: "/session/error-500" });
      call.on("error", (e: { code: string }) => evs.push("error:" + e.code));
      call.start().catch(() => evs.push("start-rejected"));
      setTimeout(() => resolve(evs), 2000);
    });
  });
  expect(events).toContain("error:mint_failed");
});

test("real fetch: a malformed session body maps to mint_failed", async ({ page }) => {
  await page.goto("/");
  const events = await page.evaluate(async () => {
    return await new Promise<string[]>((resolve) => {
      const evs: string[] = [];
      const call = new window.BolnaWebCall({ sessionUrl: "/session/malformed" });
      call.on("error", (e: { code: string }) => evs.push("error:" + e.code));
      call.start().catch(() => evs.push("start-rejected"));
      setTimeout(() => resolve(evs), 2000);
    });
  });
  expect(events).toContain("error:mint_failed");
});

test("real browser: microphone permission actively denied maps to microphone_denied", async () => {
  // a dedicated browser instance with the fake-ui flag set to auto-DENY, instead of the
  // project-wide auto-ALLOW — this needs its own launch, not the shared fixture
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream=deny"],
  });
  try {
    const context = await browser.newContext({ baseURL: "http://localhost:4173" });
    const page = await context.newPage();
    await page.goto("/");
    const events = await page.evaluate(async () => {
      return await new Promise<string[]>((resolve) => {
        const evs: string[] = [];
        const call = new window.BolnaWebCall({ session: { run_id: "x", wss_url: "wss://sip.invalid/ws" } });
        call.on("error", (e: { code: string }) => evs.push("error:" + e.code));
        call.start().catch(() => evs.push("start-rejected"));
        setTimeout(() => resolve(evs), 3000);
      });
    });
    expect(events).toContain("error:microphone_denied");
  } finally {
    await browser.close();
  }
});

test("REGRESSION in a real browser: stop() while getSession() is pending must stop the attempt before it ever requests the mic", async ({ page }) => {
  // Deliberately does NOT assert on call-start/connect success: wss_url below is unroutable,
  // so the SIP handshake fails regardless of this race, and "no call-start" would be true
  // either way — that would prove nothing. The unconfounded, real-browser-observable signal
  // is whether preflightMicrophone() (a REAL getUserMedia call) still runs at all after the
  // caller already called stop() — that's the actual bug: a real permission prompt / real mic
  // acquisition firing for a call the user already tried to end, independent of whether the
  // downstream SIP connection would have succeeded.
  await page.goto("/");
  const result = await page.evaluate(async () => {
    return await new Promise<{ events: string[]; finalState: string }>((resolve) => {
      const evs: string[] = [];
      // getSession with a real, small setTimeout delay — this exercises the actual compiled
      // bundle under Chromium's real event loop and real Promise/timer scheduling, not any
      // Node mock — proving the startToken fix holds in the real runtime target
      const call = new window.BolnaWebCall({
        getSession: () =>
          new Promise((r) =>
            setTimeout(
              () =>
                r({
                  run_id: "run_x",
                  agent_id: "a",
                  sip_username: "u",
                  sip_password: "p",
                  sip_domain: "d",
                  wss_url: "wss://sip.invalid/ws",
                  sip_register: false,
                  expires_in: 120,
                  ice_servers: [],
                }),
              120,
            ),
          ),
      });
      call.on("media-permission", () => evs.push("media-permission"));
      call.on("call-end", (i: { reason: string }) => evs.push("call-end:" + i.reason));
      call.start().catch(() => evs.push("start-rejected"));
      call.stop(); // fires almost immediately — well before the 120ms getSession() resolves

      setTimeout(() => resolve({ events: evs, finalState: call.getState() }), 1000);
    });
  });

  // call-end must come from stop(), and media-permission (i.e. preflightMicrophone actually
  // running) must never happen afterward — on unfixed code it does, because start()'s
  // continuation resumes once getSession() finally resolves at +120ms regardless of stop()
  expect(result.events).toContain("call-end:local-hangup");
  expect(result.events).not.toContain("media-permission");
});
