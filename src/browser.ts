import type { BrowserStatus, BrowserView, BrowserViewAccess, BrowserViewError } from "./types";

const POLL_MS = 1_500;
const MAX_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
// After the call ends, keep looking this long at most, so the view shows how the browser finished.
const FINISH_GRACE_MS = 15_000;
const FINISHED: ReadonlySet<BrowserStatus> = new Set(["done", "failed", "stopped"]);

class ViewExpired extends Error {}

function hasVisibilityApi(): boolean {
  return typeof document !== "undefined" && typeof document.addEventListener === "function" && "hidden" in document;
}

/** Follows the browser on one call through Bolna's read-only view endpoints. Polls only while the page is
 *  visible, backs off when a request fails, and stops for good once the call's key is no longer valid. */
export class BrowserWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delayMs = POLL_MS;
  private running = false;
  private polling = false;
  private failing = false;
  private recheckScreenshot = false;
  private finishBy: number | null = null;
  private inFlight: AbortController | null = null;
  private latest: BrowserView | null = null;
  private screenshotUrl: string | null = null;
  private readonly onVisibilityChange = () => {
    if (document.hidden) this.clearTimer();
    // a poll in flight schedules the next one itself
    else if (!this.polling) this.schedule(0);
  };

  constructor(
    private readonly access: BrowserViewAccess,
    private readonly onUpdate: (view: BrowserView) => void,
    private readonly onError: (error: BrowserViewError) => void,
  ) {}

  /** The latest view, or null before the browser has shown anything. */
  get view(): BrowserView | null {
    return this.latest;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (hasVisibilityApi()) document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.schedule(0);
  }

  /** The call ended: keep looking until the browser's outcome shows, for FINISH_GRACE_MS at most. */
  finish(): void {
    if (!this.running) return;
    if (this.latest && FINISHED.has(this.latest.status)) this.stop();
    else this.finishBy = Date.now() + FINISH_GRACE_MS;
  }

  /** Stop asking. The last view, its screenshot included, stays usable until release(). */
  stop(): void {
    this.running = false;
    this.clearTimer();
    this.inFlight?.abort();
    if (hasVisibilityApi()) document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** Stop, and free the last screenshot: nothing shows this view any more. */
  release(): void {
    this.stop();
    if (this.screenshotUrl) {
      URL.revokeObjectURL(this.screenshotUrl);
      this.screenshotUrl = null;
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.running || (hasVisibilityApi() && document.hidden)) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    this.timer = null;
    this.polling = true;
    try {
      const view = await this.fetchView();
      if (!this.running) return;
      this.delayMs = POLL_MS;
      this.failing = false;
      if (view) {
        this.latest = view;
        this.onUpdate(view);
      }
    } catch (err) {
      if (!this.running) return;
      if (err instanceof ViewExpired) {
        this.stop();
        this.onError({ code: "view_expired", message: "The browser view for this call is no longer available" });
        return;
      }
      this.delayMs = Math.min(this.delayMs * 2, MAX_BACKOFF_MS);
      // once per run of failures, not on every retry
      if (!this.failing) {
        this.failing = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.onError({ code: "view_unavailable", message: `Couldn't load the browser view: ${reason}` });
      }
    } finally {
      this.polling = false;
    }
    const finished = this.latest !== null && FINISHED.has(this.latest.status);
    if (this.finishBy !== null && (finished || Date.now() >= this.finishBy)) {
      this.stop();
      return;
    }
    this.schedule(this.delayMs);
  }

  private url(path: string): string {
    return `${this.access.api_base_url.replace(/\/+$/, "")}/browser-agent/${path}`;
  }

  private async request(path: string): Promise<Response> {
    const controller = new AbortController();
    this.inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(this.url(path), {
        headers: { Authorization: `Bearer ${this.access.token}` },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The new view, or null when nothing changed since the last one. */
  private async fetchView(): Promise<BrowserView | null> {
    const since = this.latest ? `?since=${encodeURIComponent(this.latest.version)}` : "";
    const response = await this.request(`view${since}`);
    if (response.status === 204) {
      // The browser saves a step's screenshot just after the step itself, so look once more after each change.
      if (!this.latest || !this.recheckScreenshot) return null;
      this.recheckScreenshot = false;
      const screenshotUrl = await this.fetchScreenshot();
      return screenshotUrl === this.latest.screenshot_url ? null : { ...this.latest, screenshot_url: screenshotUrl };
    }
    if (response.status === 404) throw new ViewExpired();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const fields = (await response.json()) as Omit<BrowserView, "screenshot_url">;
    this.recheckScreenshot = true;
    return { ...fields, screenshot_url: await this.fetchScreenshot() };
  }

  /** The latest screenshot as an object URL. A failed fetch keeps the previous one: the next view retries. */
  private async fetchScreenshot(): Promise<string | null> {
    try {
      const response = await this.request("view/screenshot");
      if (response.status !== 200) return this.screenshotUrl;
      const image = await response.blob();
      // stopped meanwhile: an object URL made now would never be freed
      if (!this.running) return this.screenshotUrl;
      const url = URL.createObjectURL(image);
      if (this.screenshotUrl) URL.revokeObjectURL(this.screenshotUrl);
      this.screenshotUrl = url;
      return url;
    } catch {
      return this.screenshotUrl;
    }
  }
}
