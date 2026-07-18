// Controllable fakes for the browser APIs BolnaWebCall touches directly (everything outside
// sip.js: mic, DOM audio element, AudioContext, fetch). Installed once per test file; tests
// mutate `browserControl` between cases.
import type { Session } from "../../src/types";

export interface BrowserControl {
  micDelayMs: number;
  micFails: boolean;
  autoplayBlocked: boolean;
  fetchDelayMs: number;
  fetchThrows: boolean;
  fetchJsonThrows: boolean;
  fetchStatus: number;
  fetchBodyMode: "valid" | "missing-fields" | "malformed" | "at-capacity" | "null";
  capacityScope: string | null;
}

export function freshBrowserControl(): BrowserControl {
  return {
    micDelayMs: 0,
    micFails: false,
    autoplayBlocked: false,
    fetchDelayMs: 0,
    fetchThrows: false,
    fetchJsonThrows: false,
    fetchStatus: 200,
    fetchBodyMode: "valid",
    capacityScope: "customer",
  };
}

export let browserControl: BrowserControl = freshBrowserControl();
export function setBrowserControl(next: BrowserControl): void {
  browserControl = next;
}

export function freshSession(overrides: Partial<Session> = {}): Session {
  return {
    run_id: "run_" + globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(36),
    agent_id: "agent_1",
    sip_username: "u_" + globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(36),
    sip_password: "p",
    sip_domain: "sip.example.com",
    wss_url: "wss://sip.example.com/ws",
    sip_register: false,
    expires_in: 120,
    ice_servers: [],
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

class FakeMediaStreamTrack {
  enabled = true;
  stopped = false;
  constructor(public kind: string) {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  private tracks: FakeMediaStreamTrack[] = [];
  addTrack(t: FakeMediaStreamTrack): void {
    this.tracks.push(t);
  }
  getTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }
}

class FakeAudioElement {
  autoplay = false;
  style: Record<string, string> = {};
  srcObject: unknown = null;
  removed = false;
  async play(): Promise<void> {
    if (browserControl.autoplayBlocked) {
      const err = new Error("play() blocked");
      err.name = "NotAllowedError";
      throw err;
    }
  }
  remove(): void {
    this.removed = true;
  }
}

class FakeAnalyserNode {
  fftSize = 2048;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  connect(): void {}
  getByteFrequencyData(arr: Uint8Array): void {
    for (let i = 0; i < arr.length; i++) arr[i] = (i * 37) % 256;
  }
}

class FakeAudioContext {
  closed = false;
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return new FakeAnalyserNode();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeWindow {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function mintedBody(): unknown {
  const c = browserControl;
  const bodies: Record<string, unknown> = {
    valid: freshSession(),
    "missing-fields": { agent_id: "agent_1" },
    malformed: "not even json shaped like a session",
    "at-capacity": { scope: c.capacityScope ?? "customer" },
    null: null,
  };
  return bodies[c.fetchBodyMode] ?? bodies.valid;
}

let installed = false;
export function installBrowserGlobals(): void {
  if (installed) return;
  installed = true;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        async getUserMedia(_constraints: unknown) {
          await wait(browserControl.micDelayMs);
          if (browserControl.micFails) {
            const err = new Error("Permission denied");
            err.name = "NotAllowedError";
            throw err;
          }
          const stream = new FakeMediaStream();
          stream.addTrack(new FakeMediaStreamTrack("audio"));
          return stream;
        },
      },
    },
  });

  (globalThis as any).MediaStream = FakeMediaStream;

  (globalThis as any).document = {
    createElement(tag: string) {
      if (tag === "audio") return new FakeAudioElement();
      throw new Error(`fake document.createElement: unsupported tag ${tag}`);
    },
    body: {
      appendChild() {
        /* no-op */
      },
    },
  };

  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).window = new FakeWindow();

  (globalThis as any).fetch = async (_url: string, _opts: unknown) => {
    const c = browserControl;
    await wait(c.fetchDelayMs);
    if (c.fetchThrows) throw new TypeError("fake network failure");
    const status = c.fetchStatus;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (c.fetchJsonThrows) throw new SyntaxError("fake invalid JSON");
        return mintedBody();
      },
    };
  };
}

export function getFakeWindow(): FakeWindow {
  return (globalThis as any).window as FakeWindow;
}
