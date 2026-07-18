import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as FakeSip from "./support/fake-sip";
import { freshSipControl, setSipControl, SessionState } from "./support/fake-sip";
import { freshBrowserControl, freshSession, setBrowserControl, getFakeWindow } from "./support/browser-env";

vi.mock("sip.js", async () => {
  const fake = await import("./support/fake-sip");
  return {
    UserAgent: fake.UserAgent,
    Inviter: fake.Inviter,
    Registerer: fake.Registerer,
    SessionState: fake.SessionState,
  };
});

const { BolnaWebCall } = await import("../src/call");

function recorder(call: InstanceType<typeof BolnaWebCall>) {
  const events: Array<[string, ...unknown[]]> = [];
  call.on("state-change", (s) => events.push(["state-change", s]));
  call.on("call-start", () => events.push(["call-start"]));
  call.on("call-end", (info) => events.push(["call-end", info.reason]));
  call.on("error", (e) => events.push(["error", e.code, e.message]));
  call.on("media-permission", () => events.push(["media-permission"]));
  call.on("volume-level", (v) => events.push(["volume-level", v]));
  return events;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const result = p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  // drain the fake-timer queue until the promise settles or the queue runs dry
  for (let i = 0; i < 200; i++) {
    const pending = await Promise.race([result, vi.advanceTimersByTimeAsync(50).then(() => "pending" as const)]);
    if (pending !== "pending") return pending;
  }
  throw new Error("settle(): promise never resolved after draining fake timers");
}

beforeEach(() => {
  vi.useFakeTimers();
  setSipControl(freshSipControl());
  setBrowserControl(freshBrowserControl());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("constructor", () => {
  it("throws when no session source is given", () => {
    expect(() => new BolnaWebCall({})).toThrow(/provide exactly one of/);
  });

  it("throws when more than one session source is given", () => {
    expect(
      () => new BolnaWebCall({ sessionUrl: "https://x", getSession: async () => freshSession() }),
    ).toThrow(/provide exactly one of/);
  });

  it.each([
    ["sessionUrl", { sessionUrl: "https://fake.example/session" }],
    ["getSession", { getSession: async () => freshSession() }],
    ["session", { session: freshSession() }],
  ])("accepts exactly one source (%s)", (_label, opts) => {
    expect(() => new BolnaWebCall(opts as any)).not.toThrow();
  });
});

describe("happy path", () => {
  it("goes idle -> connecting -> ringing -> active and emits call-start/media-permission", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);

    const result = await settle(call.start());
    expect(result.ok).toBe(true);

    expect(call.getState()).toBe("active");
    expect(events.map((e) => e[0])).toEqual(
      expect.arrayContaining(["state-change", "media-permission", "call-start"]),
    );
    const states = events.filter((e) => e[0] === "state-change").map((e) => e[1]);
    expect(states).toEqual(["connecting", "ringing", "active"]);
  });

  it("sets runId from the minted session", async () => {
    const session = freshSession({ run_id: "run_specific_123" });
    const call = new BolnaWebCall({ session });
    await settle(call.start());
    expect(call.getRunId()).toBe("run_specific_123");
  });

  it("stop() after an active call sends BYE and ends cleanly", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    await settle(call.start());

    const inviter = FakeSip.sipControl.inviters[0];
    await settle(call.stop());

    expect(inviter.byeCallCount).toBe(1);
    expect(call.getState()).toBe("ended");
    expect(events.filter((e) => e[0] === "call-end")).toEqual([["call-end", "local-hangup"]]);
  });
});

describe("session minting error mapping", () => {
  it("session mode: single-use — a second start() after the session is consumed fails with mint_failed", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    await settle(call.start());
    await settle(call.stop());

    const events = recorder(call);
    const result = await settle(call.start());
    expect(result.ok).toBe(false);
    const errorEvent = events.find((e) => e[0] === "error") as [string, string, string];
    expect(errorEvent[1]).toBe("mint_failed");
    expect(errorEvent[2]).toMatch(/already used/);
  });

  it("getSession mode: a thrown error surfaces as mint_failed, preserving the message", async () => {
    const call = new BolnaWebCall({
      getSession: async () => {
        throw new Error("custom backend said no");
      },
    });
    const events = recorder(call);
    const result = await settle(call.start());
    expect(result.ok).toBe(false);
    const errorEvent = events.find((e) => e[0] === "error") as [string, string, string];
    expect(errorEvent[1]).toBe("mint_failed");
    expect(errorEvent[2]).toBe("custom backend said no");
  });

  it("sessionUrl mode: HTTP 429 maps to at_capacity with the response's scope", async () => {
    setBrowserControl({ ...freshBrowserControl(), fetchStatus: 429, fetchBodyMode: "at-capacity", capacityScope: "global" });
    const call = new BolnaWebCall({ sessionUrl: "https://fake.example/session" });
    const events = recorder(call);
    const result = await settle(call.start());
    expect(result.ok).toBe(false);
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("at_capacity");
  });

  it("sessionUrl mode: a non-2xx, non-429 status maps to mint_failed", async () => {
    setBrowserControl({ ...freshBrowserControl(), fetchStatus: 500 });
    const call = new BolnaWebCall({ sessionUrl: "https://fake.example/session" });
    const events = recorder(call);
    await settle(call.start());
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("mint_failed");
  });

  it("sessionUrl mode: a malformed mint body maps to mint_failed", async () => {
    setBrowserControl({ ...freshBrowserControl(), fetchBodyMode: "missing-fields" });
    const call = new BolnaWebCall({ sessionUrl: "https://fake.example/session" });
    const events = recorder(call);
    await settle(call.start());
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("mint_failed");
  });

  it("sessionUrl mode: a network failure maps to mint_failed", async () => {
    setBrowserControl({ ...freshBrowserControl(), fetchThrows: true });
    const call = new BolnaWebCall({ sessionUrl: "https://fake.example/session" });
    const events = recorder(call);
    await settle(call.start());
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("mint_failed");
  });

  it("microphone denial maps to microphone_denied", async () => {
    setBrowserControl({ ...freshBrowserControl(), micFails: true });
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    const result = await settle(call.start());
    expect(result.ok).toBe(false);
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("microphone_denied");
  });
});

describe("already_active", () => {
  it("a second start() while connecting rejects with already_active and does not disturb the first attempt", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    const firstStart = call.start();
    const second = await settle(call.start());
    expect(second.ok).toBe(false);
    expect(events.find((e) => e[0] === "error")?.[1]).toBe("already_active");

    const first = await settle(firstStart);
    expect(first.ok).toBe(true);
    expect(call.getState()).toBe("active");
  });
});

describe("REGRESSION: stop() during an in-flight start() must not resurrect the call", () => {
  // This is the bug fixed by the startToken guard in call.ts: stop() called before connect()
  // has created a SIP inviter used to be a no-op, letting start()'s continuation dial out and
  // fire call-start after the caller already tried to end the call.

  it("stop() called while fetchSession() is pending", async () => {
    let resolveSession!: (s: ReturnType<typeof freshSession>) => void;
    const call = new BolnaWebCall({
      getSession: () => new Promise((resolve) => (resolveSession = resolve)),
    });
    const events = recorder(call);

    const startP = call.start().catch(() => {});
    const stopP = call.stop(); // fires before fetchSession() has anything to hang up
    await vi.advanceTimersByTimeAsync(10);
    resolveSession(freshSession()); // the mint finally "arrives" after stop() already ran
    await settle(Promise.all([startP, stopP]));
    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((e) => e[0] === "call-start")).toBe(false);
    expect(call.getState()).not.toBe("active");
  });

  it("stop() called while the microphone-permission prompt is pending", async () => {
    setBrowserControl({ ...freshBrowserControl(), micDelayMs: 50 });
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);

    const startP = call.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(5); // land inside preflightMicrophone()'s delay
    const stopP = call.stop();
    await settle(Promise.all([startP, stopP]));
    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((e) => e[0] === "call-start")).toBe(false);
    expect(call.getState()).not.toBe("active");
  });

  it("stop() called right after the SIP inviter is created, before invite() has moved it out of 'Initial'", async () => {
    // sendHangup() only special-cases Established (bye) and Establishing (cancel) — this
    // targets the narrow gap where the inviter already exists but invite()'s own async
    // stateChange script hasn't fired yet, so its .state is still "Initial"
    setSipControl({
      ...freshSipControl(),
      inviteCallDelayMs: 30,
      inviteScript: [
        { state: SessionState.Establishing, delayMs: 1 },
        { state: SessionState.Established, delayMs: 1 },
      ],
    });
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);

    void call.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(10); // inviter constructed, invite() still pending
    expect(FakeSip.sipControl.inviters[0]?.state).toBe(SessionState.Initial);
    void call.stop();
    // note: this sub-case's abandoned connect() promise only ever settles at the full 30s
    // CONNECT_TIMEOUT_MS (a separate, lower-severity dangling-timer wart — see PR notes) —
    // so this checks the fast, immediately-observable invariant rather than awaiting full
    // settlement of start()
    await vi.advanceTimersByTimeAsync(1000);

    expect(events.some((e) => e[0] === "call-start")).toBe(false);
    expect(call.getState()).not.toBe("active");
  });

  it("stop() called mid-connect (after Establishing, before Established) hangs up instead of going active", async () => {
    setSipControl({
      ...freshSipControl(),
      inviteScript: [
        { state: SessionState.Establishing, delayMs: 5 },
        { state: SessionState.Established, delayMs: 50 },
      ],
    });
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);

    const startP = call.start().catch(() => {});
    await vi.advanceTimersByTimeAsync(10); // past Establishing, before Established
    const stopP = call.stop();
    await settle(Promise.all([startP, stopP]));
    await vi.advanceTimersByTimeAsync(500);

    expect(events.some((e) => e[0] === "call-start")).toBe(false);
    expect(call.getState()).not.toBe("active");
  });

  it("start() after a cancelled attempt still works normally (token isn't permanently poisoned)", async () => {
    const call = new BolnaWebCall({ getSession: async () => freshSession() });
    const startP = call.start().catch(() => {});
    const stopP = call.stop();
    await settle(Promise.all([startP, stopP]));
    await vi.advanceTimersByTimeAsync(200);

    const events = recorder(call);
    const secondSessionCall = new BolnaWebCall({ session: freshSession() });
    const events2 = recorder(secondSessionCall);
    const result = await settle(secondSessionCall.start());
    expect(result.ok).toBe(true);
    expect(secondSessionCall.getState()).toBe("active");
  });
});

describe("event emitter safety", () => {
  it("a throwing listener does not stop other listeners or propagate out of start()", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    let normalListenerRan = 0;
    call.on("state-change", () => {
      throw new Error("boom");
    });
    call.on("state-change", () => normalListenerRan++);

    const result = await settle(call.start());
    expect(result.ok).toBe(true);
    expect(normalListenerRan).toBeGreaterThan(0);
  });

  it("once() fires at most one time", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    let fired = 0;
    call.once("state-change", () => fired++);
    await settle(call.start());
    await settle(call.stop());
    expect(fired).toBe(1);
  });
});

describe("disconnect grace window (DISCONNECT_GRACE_MS = 6000ms)", () => {
  it("recovering within the grace window does not end the call", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    await settle(call.start());

    const pc = FakeSip.sipControl.inviters[0].sessionDescriptionHandler.peerConnection;
    pc.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(3000); // well inside the 6s grace window
    pc.setConnectionState("connected");
    await vi.advanceTimersByTimeAsync(9000); // past where the original grace timer would have fired

    expect(events.some((e) => e[0] === "call-end")).toBe(false);
    expect(call.getState()).toBe("active");
  });

  it("staying disconnected past the grace window ends the call as remote-hangup", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    await settle(call.start());

    const pc = FakeSip.sipControl.inviters[0].sessionDescriptionHandler.peerConnection;
    pc.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(6500); // past the 6s grace window, never recovered

    expect(events.filter((e) => e[0] === "call-end")).toEqual([["call-end", "remote-hangup"]]);
  });

  it("connectionState 'failed' ends the call immediately, no grace period", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    await settle(call.start());

    const pc = FakeSip.sipControl.inviters[0].sessionDescriptionHandler.peerConnection;
    pc.setConnectionState("failed");
    await vi.advanceTimersByTimeAsync(10);

    expect(events.filter((e) => e[0] === "call-end")).toEqual([["call-end", "remote-hangup"]]);
  });
});

describe("setMuted / isMuted", () => {
  it("toggles the local audio sender track's enabled flag", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    await settle(call.start());

    expect(call.isMuted()).toBe(false);
    call.setMuted(true);
    expect(call.isMuted()).toBe(true);
    const pc = FakeSip.sipControl.inviters[0].sessionDescriptionHandler.peerConnection;
    expect(pc.getSenders()[0].track.enabled).toBe(false);

    call.setMuted(false);
    expect(pc.getSenders()[0].track.enabled).toBe(true);
  });
});

describe("pagehide teardown", () => {
  it("dispatching pagehide hangs up an active call", async () => {
    const call = new BolnaWebCall({ session: freshSession() });
    const events = recorder(call);
    await settle(call.start());

    getFakeWindow().dispatch("pagehide");
    await vi.advanceTimersByTimeAsync(100);

    expect(events.some((e) => e[0] === "call-end")).toBe(true);
    expect(call.getState()).toBe("ended");
  });
});
