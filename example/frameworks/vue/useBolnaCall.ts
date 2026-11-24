// Vue 3 composable around @bolna/web-call: one call per component, hung up on unmount.
// Call start() from a @click handler (browsers only allow audio from a user gesture).
import { onBeforeUnmount, ref, shallowRef } from "vue";
import { BolnaWebCall, type CallError, type CallState } from "@bolna/web-call";

export function useBolnaCall(sessionUrl: string, userData?: Record<string, unknown>) {
  const call = shallowRef<BolnaWebCall | null>(null);
  const state = ref<CallState>("idle");
  const error = ref<CallError | null>(null);
  const muted = ref(false);
  const volume = ref(0);

  async function start() {
    await call.value?.stop();
    const c = new BolnaWebCall({ sessionUrl, userData });
    c.on("state-change", (s) => (state.value = s));
    c.on("error", (e) => (error.value = e));
    c.on("volume-level", (v) => (volume.value = v));
    c.on("call-end", () => (volume.value = 0));
    call.value = c;
    error.value = null;
    muted.value = false;
    // the error event already carries the failure; don't leave an unhandled rejection
    await c.start().catch(() => {});
  }

  function stop() {
    return call.value?.stop();
  }

  function setMuted(value: boolean) {
    call.value?.setMuted(value);
    muted.value = value;
  }

  onBeforeUnmount(() => void call.value?.stop());

  return { state, error, muted, volume, start, stop, setMuted };
}
