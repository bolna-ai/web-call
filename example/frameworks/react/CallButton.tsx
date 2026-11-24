import { useBolnaCall } from "./useBolnaCall";

export function CallButton() {
  const { state, error, muted, start, stop, setMuted } = useBolnaCall("/api/bolna-session");
  const live = state === "connecting" || state === "ringing" || state === "active";

  return (
    <div>
      <button onClick={live ? stop : start}>{live ? "Hang up" : "Talk to our agent"}</button>
      {state === "active" && <button onClick={() => setMuted(!muted)}>{muted ? "Unmute" : "Mute"}</button>}
      <p>{state}</p>
      {error && <p role="alert">{error.code}: {error.message}</p>}
    </div>
  );
}
