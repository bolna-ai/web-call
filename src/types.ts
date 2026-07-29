/** The per-call session minted by YOUR backend via POST /web-call/freeswitch-session.
 *  Short-lived (expires_in seconds) and single-use — fetch a fresh one per call. */
export interface Session {
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

export type CallState = "idle" | "connecting" | "ringing" | "active" | "ended";

export type ErrorCode =
  | "mint_failed"
  | "at_capacity"
  | "microphone_denied"
  | "connect_failed"
  | "call_rejected"
  | "autoplay_blocked"
  | "already_active";

export interface CallError {
  code: ErrorCode;
  message: string;
  /** which cap tripped when code === "at_capacity" ("global" | "customer" | "not_enabled") */
  scope?: string;
  cause?: unknown;
}

export interface CallEndInfo {
  /** "local-hangup" | "remote-hangup" | "failed" */
  reason: string;
}

export interface BolnaWebCallOptions {
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

export interface BolnaWebCallEvents {
  "state-change": (state: CallState) => void;
  "call-start": () => void;
  "call-end": (info: CallEndInfo) => void;
  error: (error: CallError) => void;
  "media-permission": () => void;
  /** Remote (agent) audio level 0..1, ~10 updates/sec while the call is active. */
  "volume-level": (level: number) => void;
}
