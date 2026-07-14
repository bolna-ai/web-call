import { Inviter, Registerer, SessionState, UserAgent } from "sip.js";

import { Emitter } from "./events";
import type {
  BolnaWebCallEvents,
  BolnaWebCallOptions,
  CallError,
  CallState,
  ErrorCode,
  Session,
} from "./types";

const DIAL_EXTENSION = "7000";
const CONNECT_TIMEOUT_MS = 30_000;
const VOLUME_INTERVAL_MS = 100;
// A brief 'disconnected' is often a transient ICE blip that recovers; only end the call
// if it stays down this long. 'failed'/'closed' end immediately (no grace).
const DISCONNECT_GRACE_MS = 6_000;

const DEFAULT_AUDIO: MediaTrackConstraints = {
  // browser AEC/NS/AGC kill speaker→mic echo at the source — the right layer for it
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

class WebCallError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public scope?: string,
    public cause2?: unknown,
  ) {
    super(message);
    this.name = "WebCallError";
  }
}

export class BolnaWebCall extends Emitter<BolnaWebCallEvents> {
  private options: BolnaWebCallOptions;
  private state: CallState = "idle";
  private runId: string | null = null;
  private userAgent: UserAgent | null = null;
  private inviter: Inviter | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private createdAudioElement = false;
  private audioContext: AudioContext | null = null;
  private volumeTimer: ReturnType<typeof setInterval> | null = null;
  private pagehideHandler: (() => void) | null = null;
  private connWatchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedPc: RTCPeerConnection | null = null;
  private onConnState: (() => void) | null = null;
  private onIceState: (() => void) | null = null;
  private endedByUs = false;
  private muted = false;

  constructor(options: BolnaWebCallOptions) {
    super();
    const sources = [options.sessionUrl, options.getSession, options.session].filter(Boolean);
    if (sources.length !== 1) {
      throw new Error("BolnaWebCall: provide exactly one of sessionUrl, getSession, or session");
    }
    this.options = options;
  }

  getState(): CallState {
    return this.state;
  }

  getRunId(): string | null {
    return this.runId;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Mute/unmute the microphone (local track toggle — the call stays up). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    const pc = this.peerConnection();
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === "audio") sender.track.enabled = !muted;
    }
  }

  /** Start a call: mint session → mic permission → connect → resolves once the agent answers.
   *  Call from a user gesture (click) so audio playback is allowed. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "ended") {
      // one attempt at a time: rapid re-clicks would each mint a fresh run_id holding a
      // concurrency slot, and the connect burst can trip the edge's anti-flood ban
      throw this.fail("already_active", "A call is already in progress");
    }
    this.endedByUs = false;
    this.muted = false;
    this.setState("connecting");

    try {
      const session = await this.fetchSession();
      this.runId = session.run_id;

      // acquire the mic BEFORE signaling: permission-denied fails fast and no slot-holding
      // SIP dialog is created for a call that can never have audio
      const audioConstraints = { ...DEFAULT_AUDIO, ...(this.options.audio ?? {}) };
      await this.preflightMicrophone(audioConstraints);
      this.emit("media-permission");

      await this.connect(session, audioConstraints);
      this.setState("active");
      this.emit("call-start");
    } catch (err) {
      const callError = this.toCallError(err);
      this.emit("error", callError);
      this.teardown("failed", false);
      throw err;
    }
  }

  /** Hang up and release everything. Safe to call in any state (idempotent). */
  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "ended") return;
    this.endedByUs = true;
    await this.sendHangup();
    this.teardown("local-hangup");
  }

  // ------------------------------------------------------------------
  // session minting
  // ------------------------------------------------------------------

  private async fetchSession(): Promise<Session> {
    const { session, getSession, sessionUrl } = this.options;
    try {
      if (!session && !getSession && !sessionUrl) {
        // a session-mode instance was already used: its single-use SIP credential is gone
        // and there is no minting source to fetch a fresh one — construct a new instance
        throw new WebCallError(
          "mint_failed",
          "This session was already used — create a new BolnaWebCall with a fresh session (SIP credentials are single-use, 120s TTL)",
        );
      }
      if (session) {
        // single-use: a session's SIP credential is consumed by its first call
        this.options = { ...this.options, session: undefined };
        return session;
      }
      if (getSession) return await getSession();
      const response = await fetch(sessionUrl!, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}) as Record<string, unknown>);
        if (response.status === 429) {
          throw new WebCallError(
            "at_capacity",
            "Concurrent web-call limit reached — try again shortly",
            typeof body.scope === "string" ? body.scope : undefined,
          );
        }
        throw new WebCallError("mint_failed", `Session mint failed: HTTP ${response.status}`);
      }
      const minted = (await response.json()) as Session;
      if (!minted.run_id || !minted.wss_url || !minted.sip_username) {
        throw new WebCallError("mint_failed", "Session mint returned an unexpected shape");
      }
      return minted;
    } catch (err) {
      if (err instanceof WebCallError) throw err;
      // preserve the consumer's message (e.g. a getSession() that maps its backend's 429
      // into user-facing text) instead of flattening every failure to one generic string
      const message =
        err instanceof Error && err.message ? err.message : "Could not reach the session endpoint";
      throw new WebCallError("mint_failed", message, undefined, err);
    }
  }

  // ------------------------------------------------------------------
  // media
  // ------------------------------------------------------------------

  private async preflightMicrophone(constraints: MediaTrackConstraints): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
      // permission is what we needed; SIP.js re-acquires with the same constraints instantly
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      throw new WebCallError("microphone_denied", "Microphone access was denied", undefined, err);
    }
  }

  private ensureAudioElement(): HTMLAudioElement {
    if (this.options.audioElement) return this.options.audioElement;
    if (!this.audioElement) {
      this.audioElement = document.createElement("audio");
      this.audioElement.autoplay = true;
      this.audioElement.style.display = "none";
      document.body.appendChild(this.audioElement);
      this.createdAudioElement = true;
    }
    return this.audioElement;
  }

  private attachRemoteAudio(): void {
    const pc = this.peerConnection();
    if (!pc) return;
    const stream = new MediaStream();
    pc.getReceivers().forEach((receiver) => {
      if (receiver.track) stream.addTrack(receiver.track);
    });
    const element = this.ensureAudioElement();
    element.srcObject = stream;
    element.play().catch((err) => {
      this.emit(
        "error",
        this.toCallError(
          new WebCallError(
            "autoplay_blocked",
            "Browser blocked audio playback — call start() from a user gesture (e.g. a click handler)",
            undefined,
            err,
          ),
        ),
      );
    });
    this.startVolumeMeter(stream);
  }

  private startVolumeMeter(stream: MediaStream): void {
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      this.volumeTimer = setInterval(() => {
        analyser.getByteFrequencyData(samples);
        let sum = 0;
        for (const value of samples) sum += value;
        this.emit("volume-level", Math.min(1, sum / samples.length / 128));
      }, VOLUME_INTERVAL_MS);
    } catch {
      // volume metering is best-effort; never fail a call over it
    }
  }

  // ------------------------------------------------------------------
  // signaling
  // ------------------------------------------------------------------

  private async connect(session: Session, audioConstraints: MediaTrackConstraints): Promise<void> {
    const host = new URL(session.wss_url).hostname;
    // the Kamailio-mode credential contains ':' (illegal in a SIP URI user part) — the URI
    // user is the plain run_id and the full ephemeral username travels only in the digest
    const uriUser = session.sip_register ? session.sip_username : session.run_id;
    const uri = UserAgent.makeURI(`sip:${uriUser}@${host}`);
    const target = UserAgent.makeURI(`sip:${DIAL_EXTENSION}@${host}`);
    if (!uri || !target) throw new WebCallError("connect_failed", "Invalid session wss_url");

    const userAgent = new UserAgent({
      uri,
      transportOptions: { server: session.wss_url },
      authorizationUsername: session.sip_username,
      authorizationPassword: session.sip_password,
      logLevel: this.options.debug ? "debug" : "error",
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          // ICE servers come only from the mint: per-call HMAC TURN credentials
          iceServers: session.ice_servers,
          ...(this.options.iceTransportPolicy
            ? { iceTransportPolicy: this.options.iceTransportPolicy }
            : {}),
        },
      },
    });
    this.userAgent = userAgent;

    try {
      await userAgent.start();
      if (session.sip_register) {
        await new Registerer(userAgent).register();
      }
    } catch (err) {
      throw new WebCallError("connect_failed", "Could not connect to the call server", undefined, err);
    }

    const inviter = new Inviter(userAgent, target, {
      extraHeaders: [`X-Agent-Id: ${session.agent_id}`, `X-Run-Id: ${session.run_id}`],
      sessionDescriptionHandlerOptions: {
        constraints: { audio: audioConstraints, video: false },
      },
    });
    this.inviter = inviter;
    this.installPagehideTeardown();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        inviter.cancel().catch(() => {});
        reject(new WebCallError("connect_failed", "Call setup timed out"));
      }, CONNECT_TIMEOUT_MS);

      inviter.stateChange.addListener((state: SessionState) => {
        // ignore late events from a superseded call: if this instance was torn down (or
        // reused for a new call), this.inviter no longer points at the inviter we bound to,
        // and acting on its Terminated would wrongly tear down the *current* call
        if (this.inviter !== inviter) return;
        if (state === SessionState.Establishing) {
          this.setState("ringing");
        } else if (state === SessionState.Established) {
          this.attachRemoteAudio();
          this.watchConnection();
          if (this.muted) this.setMuted(true);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } else if (state === SessionState.Terminated) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new WebCallError("call_rejected", "Call was rejected before connecting"));
          } else {
            // mid-call end: agent hung up (or network dropped the dialog)
            this.teardown(this.endedByUs ? "local-hangup" : "remote-hangup");
          }
        }
      });

      inviter.invite().catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new WebCallError("connect_failed", "INVITE failed", undefined, err));
      });
    });
  }

  private peerConnection(): RTCPeerConnection | null {
    const handler = this.inviter?.sessionDescriptionHandler as
      | { peerConnection?: RTCPeerConnection }
      | undefined;
    return handler?.peerConnection ?? null;
  }

  /** Backstop for a lost SIP BYE: when the far end (agent) ends the call, the media
   *  transport tears down even if the BYE never reaches us. End the call on that so the
   *  UI can never get stuck "in call" waiting on signaling that isn't coming. */
  private watchConnection(): void {
    const pc = this.peerConnection();
    if (!pc) return;
    const onState = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed") {
        this.teardown("remote-hangup");
      } else if (s === "disconnected") {
        if (this.connWatchTimer) return;
        this.connWatchTimer = setTimeout(() => {
          this.connWatchTimer = null;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            this.teardown("remote-hangup");
          }
        }, DISCONNECT_GRACE_MS);
      } else if (this.connWatchTimer) {
        // recovered (connected/completed) — cancel the pending end
        clearTimeout(this.connWatchTimer);
        this.connWatchTimer = null;
      }
    };
    // Safari / older Chromium surface teardown on iceConnectionState instead
    const onIce = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        this.teardown("remote-hangup");
      }
    };
    pc.addEventListener("connectionstatechange", onState);
    pc.addEventListener("iceconnectionstatechange", onIce);
    // keep refs so teardown can detach them — otherwise userAgent.stop() closing the pc
    // re-fires these into a torn-down instance, and the closures keep `this` alive via the pc
    this.watchedPc = pc;
    this.onConnState = onState;
    this.onIceState = onIce;
  }

  private async sendHangup(): Promise<void> {
    const inviter = this.inviter;
    if (!inviter) return;
    try {
      if (inviter.state === SessionState.Established) await inviter.bye();
      else if (inviter.state === SessionState.Establishing) await inviter.cancel();
    } catch {
      // dialog already gone — teardown proceeds regardless
    }
  }

  // ------------------------------------------------------------------
  // teardown
  // ------------------------------------------------------------------

  private installPagehideTeardown(): void {
    // tab close / navigation: BYE best-effort so the call slot frees immediately
    // instead of waiting for the server-side unconnected reap
    this.pagehideHandler = () => {
      void this.sendHangup();
      this.teardown("local-hangup");
    };
    window.addEventListener("pagehide", this.pagehideHandler);
  }

  private teardown(reason: string, emitEnd = true): void {
    if (this.pagehideHandler) {
      window.removeEventListener("pagehide", this.pagehideHandler);
      this.pagehideHandler = null;
    }
    if (this.volumeTimer) {
      clearInterval(this.volumeTimer);
      this.volumeTimer = null;
    }
    if (this.connWatchTimer) {
      clearTimeout(this.connWatchTimer);
      this.connWatchTimer = null;
    }
    if (this.watchedPc) {
      if (this.onConnState) this.watchedPc.removeEventListener("connectionstatechange", this.onConnState);
      if (this.onIceState) this.watchedPc.removeEventListener("iceconnectionstatechange", this.onIceState);
      this.watchedPc = null;
      this.onConnState = null;
      this.onIceState = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      if (this.createdAudioElement) this.audioElement.remove();
      this.audioElement = null;
      this.createdAudioElement = false;
    }
    const userAgent = this.userAgent;
    this.userAgent = null;
    this.inviter = null;
    if (userAgent) userAgent.stop().catch(() => {});

    const wasLive = this.state === "active" || this.state === "ringing" || this.state === "connecting";
    this.setState("ended");
    if (emitEnd && wasLive) this.emit("call-end", { reason });
  }

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  private setState(state: CallState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state-change", state);
    if (this.options.debug) console.log(`[bolna-web-call] state → ${state}`);
  }

  private fail(code: ErrorCode, message: string): WebCallError {
    const error = new WebCallError(code, message);
    this.emit("error", this.toCallError(error));
    return error;
  }

  private toCallError(err: unknown): CallError {
    if (err instanceof WebCallError) {
      return { code: err.code, message: err.message, scope: err.scope, cause: err.cause2 };
    }
    return { code: "connect_failed", message: err instanceof Error ? err.message : String(err), cause: err };
  }
}
