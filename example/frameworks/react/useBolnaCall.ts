// React hook around @bolna/web-call: one call per component, hung up on unmount.
// Call start() from an onClick handler (browsers only allow audio from a user gesture).
import { useCallback, useEffect, useRef, useState } from "react";
import { BolnaWebCall, type CallError, type CallState } from "@bolna/web-call";

export function useBolnaCall(sessionUrl: string, userData?: Record<string, unknown>) {
  const callRef = useRef<BolnaWebCall | null>(null);
  const [state, setState] = useState<CallState>("idle");
  const [error, setError] = useState<CallError | null>(null);
  const [muted, setMutedState] = useState(false);
  const [volume, setVolume] = useState(0);

  const start = useCallback(async () => {
    await callRef.current?.stop();
    const call = new BolnaWebCall({ sessionUrl, userData });
    call.on("state-change", setState);
    call.on("error", setError);
    call.on("volume-level", setVolume);
    call.on("call-end", () => setVolume(0));
    callRef.current = call;
    setError(null);
    setMutedState(false);
    // the error event already carries the failure; don't leave an unhandled rejection
    await call.start().catch(() => {});
  }, [sessionUrl, userData]);

  const stop = useCallback(() => callRef.current?.stop(), []);

  const setMuted = useCallback((value: boolean) => {
    callRef.current?.setMuted(value);
    setMutedState(value);
  }, []);

  useEffect(() => () => void callRef.current?.stop(), []);

  return { state, error, muted, volume, start, stop, setMuted };
}
