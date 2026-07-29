/** Minimal typed event emitter — no dependency, listener errors never break the SDK. */
type Listener = (...args: any[]) => void;
declare class Emitter<Events extends {
    [K in keyof Events]: Listener;
}> {
    private listeners;
    on<K extends keyof Events>(event: K, listener: Events[K]): this;
    once<K extends keyof Events>(event: K, listener: Events[K]): this;
    off<K extends keyof Events>(event: K, listener: Events[K]): this;
    protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void;
    protected removeAllListeners(): void;
}

/** The per-call session minted by YOUR backend via POST /web-call/freeswitch-session.
 *  Short-lived (expires_in seconds) and single-use — fetch a fresh one per call. */
interface Session {
    run_id: string;
    agent_id: string;
    sip_username: string;
    sip_password: string;
    sip_domain: string;
    wss_url: string;
    /** false = Kamailio edge (digest on INVITE, no REGISTER); true = direct FreeSWITCH */
    sip_register: boolean;
    expires_in: number;
    ice_servers: RTCIceServer[];
}
type CallState = "idle" | "connecting" | "ringing" | "active" | "ended";
type ErrorCode = "mint_failed" | "at_capacity" | "microphone_denied" | "connect_failed" | "call_rejected" | "autoplay_blocked" | "already_active";
interface CallError {
    code: ErrorCode;
    message: string;
    /** which cap tripped when code === "at_capacity" ("global" | "customer" | "not_enabled") */
    scope?: string;
    cause?: unknown;
}
interface CallEndInfo {
    /** "local-hangup" | "remote-hangup" | "failed" */
    reason: string;
}
interface BolnaWebCallOptions {
    /** URL of YOUR backend endpoint that mints a session (POSTed with no body).
     *  Your server calls Bolna's /web-call/freeswitch-session with your bn- API key
     *  and returns the JSON as-is. Never put the bn- key in the browser. */
    sessionUrl?: string;
    /** Full control over minting (custom fetch/auth/headers). Return the mint JSON. */
    getSession?: () => Promise<Session>;
    /** A pre-fetched session. Single-use and short-lived — prefer sessionUrl/getSession. */
    session?: Session;
    /** Dynamic variables for this call — substituted into the agent's prompt and welcome
     *  message, same as the telephony /call API's user_data. Sent as {"user_data": ...} in the
     *  POST body to sessionUrl; if you use getSession or a pre-fetched session, forward it to
     *  Bolna's /web-call/freeswitch-session yourself. Can be overridden per call via start(). */
    userData?: Record<string, unknown>;
    /** Mic constraints. Defaults keep echoCancellation/noiseSuppression/autoGainControl on. */
    audio?: MediaTrackConstraints;
    /** "relay" forces TURN (testing/restrictive networks). Default "all". */
    iceTransportPolicy?: RTCIceTransportPolicy;
    /** Element to play the agent's audio through; the SDK creates a hidden one if omitted. */
    audioElement?: HTMLAudioElement;
    debug?: boolean;
}
interface BolnaWebCallEvents {
    "state-change": (state: CallState) => void;
    "call-start": () => void;
    "call-end": (info: CallEndInfo) => void;
    error: (error: CallError) => void;
    "media-permission": () => void;
    /** Remote (agent) audio level 0..1, ~10 updates/sec while the call is active. */
    "volume-level": (level: number) => void;
}

declare class BolnaWebCall extends Emitter<BolnaWebCallEvents> {
    private options;
    private state;
    private runId;
    private userAgent;
    private inviter;
    private audioElement;
    private createdAudioElement;
    private audioContext;
    private volumeTimer;
    private pagehideHandler;
    private connWatchTimer;
    private watchedPc;
    private onConnState;
    private onIceState;
    private endedByUs;
    private muted;
    constructor(options: BolnaWebCallOptions);
    getState(): CallState;
    getRunId(): string | null;
    isMuted(): boolean;
    /** Mute/unmute the microphone (local track toggle — the call stays up). */
    setMuted(muted: boolean): void;
    /** Start a call: mint session → mic permission → connect → resolves once the agent answers.
     *  Call from a user gesture (click) so audio playback is allowed.
     *  `options.userData` overrides the constructor's userData for this call. */
    start(options?: {
        userData?: Record<string, unknown>;
    }): Promise<void>;
    /** Hang up and release everything. Safe to call in any state (idempotent). */
    stop(): Promise<void>;
    private fetchSession;
    private preflightMicrophone;
    private ensureAudioElement;
    private attachRemoteAudio;
    private startVolumeMeter;
    private connect;
    private peerConnection;
    /** Backstop for a lost SIP BYE: when the far end (agent) ends the call, the media
     *  transport tears down even if the BYE never reaches us. End the call on that so the
     *  UI can never get stuck "in call" waiting on signaling that isn't coming. */
    private watchConnection;
    private sendHangup;
    private installPagehideTeardown;
    private teardown;
    private setState;
    private fail;
    private toCallError;
}

export { BolnaWebCall, type BolnaWebCallEvents, type BolnaWebCallOptions, type CallEndInfo, type CallError, type CallState, type ErrorCode, type Session };
