// Controllable stand-in for SIP.js's UserAgent/Inviter/Registerer/SessionState. Tests drive
// call.ts's own state machine and error handling through `sipControl` — no real SIP server or
// WebRTC stack involved. Mounted in place of the real "sip.js" module via vi.mock().

export const SessionState = {
  Initial: "Initial",
  Establishing: "Establishing",
  Established: "Established",
  Terminating: "Terminating",
  Terminated: "Terminated",
} as const;

export interface SipControl {
  userAgentStartDelayMs: number;
  userAgentStartFails: boolean;
  registerDelayMs: number;
  registerFails: boolean;
  inviteCallDelayMs: number;
  inviteRejects: boolean;
  inviteScript: Array<{ state: string; delayMs: number }>;
  badURI: boolean;
  /** every Inviter constructed while this control object is active, in creation order */
  inviters: FakeInviter[];
}

export function freshSipControl(): SipControl {
  return {
    userAgentStartDelayMs: 0,
    userAgentStartFails: false,
    registerDelayMs: 0,
    registerFails: false,
    inviteCallDelayMs: 0,
    inviteRejects: false,
    inviteScript: [
      { state: SessionState.Establishing, delayMs: 1 },
      { state: SessionState.Established, delayMs: 1 },
    ],
    badURI: false,
    inviters: [],
  };
}

// tests reassign this between cases; every fake class below reads it live
export let sipControl: SipControl = freshSipControl();
export function setSipControl(next: SipControl): void {
  sipControl = next;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms || 0));
}

class FakeListenerBag<T> {
  private listeners: Array<(v: T) => void> = [];
  addListener(fn: (v: T) => void): void {
    this.listeners.push(fn);
  }
  removeListener(fn: (v: T) => void): void {
    this.listeners = this.listeners.filter((x) => x !== fn);
  }
  fire(v: T): void {
    for (const fn of this.listeners.slice()) fn(v);
  }
}

export class FakePeerConnection {
  connectionState = "new";
  iceConnectionState = "new";
  private listeners: Record<string, Array<() => void>> = {};
  private senders = [{ track: { kind: "audio", enabled: true } }];
  getSenders() {
    return this.senders;
  }
  getReceivers() {
    return [{ track: { kind: "audio" } }];
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((x) => x !== fn);
  }
  setConnectionState(s: string): void {
    this.connectionState = s;
    (this.listeners["connectionstatechange"] || []).slice().forEach((fn) => fn());
  }
  setIceState(s: string): void {
    this.iceConnectionState = s;
    (this.listeners["iceconnectionstatechange"] || []).slice().forEach((fn) => fn());
  }
}

export class UserAgent {
  options: unknown;
  static makeURI(str: string) {
    if (sipControl.badURI) return null;
    return { toString: () => str, raw: str };
  }
  constructor(options: unknown) {
    this.options = options;
  }
  async start(): Promise<void> {
    await wait(sipControl.userAgentStartDelayMs);
    if (sipControl.userAgentStartFails) throw new Error("fake transport connect failed");
  }
  async stop(): Promise<void> {
    await wait(0);
  }
}

export class Registerer {
  constructor(public userAgent: UserAgent) {}
  async register(): Promise<void> {
    await wait(sipControl.registerDelayMs);
    if (sipControl.registerFails) throw new Error("fake register failed");
  }
}

export class FakeInviter {
  state: string = SessionState.Initial;
  stateChange = new FakeListenerBag<string>();
  sessionDescriptionHandler: { peerConnection: FakePeerConnection };
  private byeCalls = 0;
  private cancelCalls = 0;

  constructor(
    public userAgent: UserAgent,
    public target: unknown,
    public options: unknown,
  ) {
    this.sessionDescriptionHandler = { peerConnection: new FakePeerConnection() };
    sipControl.inviters.push(this);
  }

  get byeCallCount() {
    return this.byeCalls;
  }
  get cancelCallCount() {
    return this.cancelCalls;
  }

  async invite(): Promise<void> {
    await wait(sipControl.inviteCallDelayMs);
    if (sipControl.inviteRejects) throw new Error("fake INVITE transport failure");
    const script = sipControl.inviteScript;
    void (async () => {
      for (const step of script) {
        await wait(step.delayMs);
        this.state = step.state;
        this.stateChange.fire(step.state);
      }
    })();
  }
  async cancel(): Promise<void> {
    this.cancelCalls++;
    await wait(0);
    this.state = SessionState.Terminated;
    this.stateChange.fire(SessionState.Terminated);
  }
  async bye(): Promise<void> {
    this.byeCalls++;
    await wait(0);
    this.state = SessionState.Terminated;
  }
}

export { FakeInviter as Inviter };
