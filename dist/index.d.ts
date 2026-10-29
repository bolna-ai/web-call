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
    /** Present when the agent can drive a browser during the call (filling a form, looking something up).
     *  The SDK uses it to follow the browser; see the browser-* events and mountBrowserPanel. */
    browser_view?: BrowserViewAccess;
}
/** A per-call key to Bolna's read-only view of the browser the agent drives. Only covers this call. */
interface BrowserViewAccess {
    token: string;
    api_base_url: string;
}
type BrowserStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
/** What the browser is doing on this call, as Bolna's GET /browser-agent/view returns it. */
interface BrowserView {
    /** Changes with every update. */
    version: string;
    status: BrowserStatus;
    /** page_fill: the caller's own page fills its form (see attachPage); there are no screenshots. */
    kind: "lookup" | "form_fill" | "page_fill";
    step: number;
    progress: string;
    /** The latest step lines, oldest first, such as "Typed into 'E-mail address'". Never the values typed. */
    recent_actions: string[];
    /** What a waiting form fill needs from the caller. */
    awaiting: "none" | "answer" | "confirmation";
    question: string;
    /** The filled-in form, read from the page, that the caller is asked to confirm. */
    confirm_summary: string;
    /** How long the browser had waited on the caller when this view was read; 0 unless it is waiting. */
    waiting_seconds: number;
    submitted: boolean;
    reference: string;
    /** A lookup's answer, or why a form fill stopped short of submitting. */
    answer: string;
    error: string;
    /** Object URL of the browser's latest screenshot, or null. The SDK revokes it once a newer one arrives or
     *  the call ends. */
    screenshot_url: string | null;
}
interface BrowserViewError {
    /** "view_expired": the call's key is no longer valid, so updates stop. "view_unavailable": a request
     *  failed; the SDK keeps retrying with backoff. */
    code: "view_expired" | "view_unavailable";
    message: string;
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
type PageFieldKind = "text" | "long_text" | "choice" | "checkbox";
/** One field of a form connected with attachPage, as the agent sees it. */
interface PageField {
    /** What the agent sends the value under: data-bolna-field, else the element's name, else its label. */
    name: string;
    label: string;
    /** choice: one of options (a select, radio group or row of option buttons). checkbox: "yes" or "no". */
    kind: PageFieldKind;
    /** A text field's own type when it isn't plain text, such as "email" or "tel". */
    input_type: string;
    required: boolean;
    options: string[];
}
interface AttachPageOptions {
    /** Sends the form after the caller's yes, with the values they confirmed: resolve with the site's reference
     *  number if it gives one, or throw with why it failed. Without it the SDK calls the form's own submit, and your
     *  submit handler says how it went with reportSubmitted or reportFailed (a form that leaves the page needs this
     *  option instead). */
    submit?: (values: Record<string, string>) => Promise<{
        reference?: string;
    } | void>;
    /** Milliseconds per character as a value types in; 0 sets it at once. Default 18. */
    typingDelayMs?: number;
}
/** What attachPage returns. */
interface PageConnection {
    /** The form's fields as the agent sees them. */
    readonly fields: PageField[];
    /** Stop filling this form; the call goes on. */
    detach(): void;
    /** Your submit handler sent the form: tell the agent, with the site's reference number if any. */
    reportSubmitted(reference?: string): void;
    /** Your submit handler couldn't send the form: tell the agent why. */
    reportFailed(reason: string): void;
}
/** connecting: telling Bolna about the form. ready: waiting for the agent. typing: filling a field. confirming:
 *  the agent is reading the form back. submitting: the caller said yes. submitted / not_submitted: the outcome.
 *  stopped: the call ended. */
type PageFillState = "connecting" | "ready" | "typing" | "confirming" | "submitting" | "submitted" | "not_submitted" | "stopped";
interface PageFillUpdate {
    state: PageFillState;
    /** While typing, the label of the field being filled. */
    field?: string;
    /** The reference number once submitted, why it wasn't, or a note about the form. */
    detail?: string;
}
interface PageFillError {
    /** page_unavailable: this call's agent can't fill pages (mid-call events off). page_failed: a request to Bolna
     *  failed; the SDK keeps retrying. */
    code: "page_unavailable" | "page_failed";
    message: string;
}
interface BolnaWebCallEvents {
    "state-change": (state: CallState) => void;
    "call-start": () => void;
    "call-end": (info: CallEndInfo) => void;
    error: (error: CallError) => void;
    "media-permission": () => void;
    /** Remote (agent) audio level 0..1, ~10 updates/sec while the call is active. */
    "volume-level": (level: number) => void;
    /** The call has a browser to follow: emitted once the call is active, when the session carried browser_view. */
    "browser-ready": () => void;
    /** The browser moved on: a new step, a question for the caller, a read-back, or its outcome. */
    "browser-update": (view: BrowserView) => void;
    /** Following the browser hit a problem. Never ends the call. */
    "browser-error": (error: BrowserViewError) => void;
    /** A form connected with attachPage moved on: typing a field, being read back, submitted. */
    "page-update": (update: PageFillUpdate) => void;
    /** Filling a form connected with attachPage hit a problem. Never ends the call. */
    "page-error": (error: PageFillError) => void;
}

interface BrowserPanelOptions {
    /** Heading above the browser. Default "Browser". */
    title?: string;
}
/** A ready-made view of the browser the agent drives on this call: its status, any question or read-back for
 *  the caller, the latest screenshot and step lines. Page text only ever goes in as text. Returns a function
 *  that removes the panel. */
declare function mountBrowserPanel(call: BolnaWebCall, container: HTMLElement, options?: BrowserPanelOptions): () => void;

declare class BolnaWebCall extends Emitter<BolnaWebCallEvents> {
    /** For the CDN build, where the global is this class: BolnaWebCall.mountBrowserPanel(call, element). */
    static readonly mountBrowserPanel: typeof mountBrowserPanel;
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
    private startToken;
    private browserAccess;
    private browserWatcher;
    private pageFillers;
    constructor(options: BolnaWebCallOptions);
    getState(): CallState;
    getRunId(): string | null;
    isMuted(): boolean;
    /** What the browser the agent drives last showed on this call, or null. Kept after the call ends, until the
     *  next start(). */
    getBrowserView(): BrowserView | null;
    /** Let the agent fill this form on your page while the caller talks: each value types in as the caller says it,
     *  the agent reads the form back from the page, and the form is submitted only after the caller's yes. Call it
     *  before or during a call; it works on every call this instance makes until detach(). Needs an agent with
     *  mid-call events on. */
    attachPage(form: HTMLElement, options?: AttachPageOptions): PageConnection;
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
    private startPageFiller;
    private followBrowser;
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

/** One field of the form, as the agent sees it, with how to read and set it on the page. */
interface ScannedField {
    info: PageField;
    read(): string;
    apply(value: string, typingDelayMs: number, isActive: () => boolean): Promise<void>;
}
/** The form's fields, in page order: text inputs, text areas, selects, radio groups, tick boxes, and rows of option
 *  buttons marked with data-bolna-field. Passwords, payment cards, one-time codes, hidden fields and anything inside
 *  data-bolna-ignore are left out. */
declare function scanForm(form: HTMLElement): ScannedField[];
/** A field name the agent can send back: lowercase letters, digits and _, starting with a letter. */
declare function fieldName(text: string): string;

export { type AttachPageOptions, BolnaWebCall, type BolnaWebCallEvents, type BolnaWebCallOptions, type BrowserPanelOptions, type BrowserStatus, type BrowserView, type BrowserViewAccess, type BrowserViewError, type CallEndInfo, type CallError, type CallState, type ErrorCode, type PageConnection, type PageField, type PageFieldKind, type PageFillError, type PageFillState, type PageFillUpdate, type Session, fieldName, mountBrowserPanel, scanForm };
