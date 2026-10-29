import type { BolnaWebCall } from "./call";
import type { BrowserView } from "./types";

const STYLE_ID = "bolna-browser-panel-style";
const WAIT_TICK_MS = 1_000;
// Light by default; a host page themes it, dark included, through the --bolna-bp-* variables on .bolna-bp or any
// ancestor.
const STYLE = `
.bolna-bp{--bolna-bp-bg:#fff;--bolna-bp-fg:#16181d;--bolna-bp-muted:#5f6672;--bolna-bp-border:#d9dce1;--bolna-bp-accent:#2563eb;--bolna-bp-radius:10px;display:grid;gap:10px;box-sizing:border-box;max-width:100%;padding:12px;color:var(--bolna-bp-fg);background:var(--bolna-bp-bg);border:1px solid var(--bolna-bp-border);border-radius:var(--bolna-bp-radius);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.bolna-bp [hidden]{display:none!important}
.bolna-bp-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.bolna-bp-title{font-weight:600}
.bolna-bp-status{color:var(--bolna-bp-muted)}
.bolna-bp[data-status=waiting] .bolna-bp-status{color:var(--bolna-bp-accent);font-weight:600}
.bolna-bp-banner{margin:0;padding:8px 10px;border:1px solid var(--bolna-bp-border);border-radius:8px;overflow-wrap:anywhere}
.bolna-bp[data-status=waiting] .bolna-bp-banner{border-color:var(--bolna-bp-accent)}
.bolna-bp-shot{display:block;width:100%;height:auto;border:1px solid var(--bolna-bp-border);border-radius:6px}
.bolna-bp-steps{margin:0;padding-left:20px;color:var(--bolna-bp-muted);overflow-wrap:anywhere}
`;

export interface BrowserPanelOptions {
  /** Heading above the browser. Default "Browser". */
  title?: string;
}

/** The panel's status line and banner for a view: what the browser is doing, and what it needs from the caller. */
export function describeBrowserView(view: BrowserView | null): { status: string; detail: string } {
  if (!view) return { status: "Not started", detail: "" };
  switch (view.status) {
    case "queued":
      return { status: "Starting", detail: "" };
    case "running":
      return { status: "Working", detail: view.progress };
    case "waiting":
      return view.awaiting === "confirmation"
        ? { status: "Please confirm", detail: view.confirm_summary }
        : { status: "Needs your answer", detail: view.question };
    case "done":
      if (view.kind === "form_fill" || view.kind === "page_fill") {
        return view.submitted
          ? { status: "Submitted", detail: view.reference }
          : { status: "Not submitted", detail: view.answer };
      }
      return { status: "Done", detail: view.answer };
    case "failed":
      return { status: "Couldn't finish", detail: view.error };
    default:
      return { status: "Stopped", detail: view.error };
  }
}

function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

/** Once per document, or per shadow root: a page's styles don't reach into one. */
function installStyle(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const root = container.getRootNode();
  const host = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root : doc.head;
  if (host.querySelector(`#${STYLE_ID}`)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  host.append(style);
}

/** A ready-made view of the browser the agent drives on this call: its status, any question or read-back for
 *  the caller, the latest screenshot and step lines. Page text only ever goes in as text. Returns a function
 *  that removes the panel. */
export function mountBrowserPanel(
  call: BolnaWebCall,
  container: HTMLElement,
  options: BrowserPanelOptions = {},
): () => void {
  const doc = container.ownerDocument;
  installStyle(container);
  const title = options.title ?? "Browser";
  const root = element(doc, "section", "bolna-bp");
  root.setAttribute("aria-label", title);
  const head = element(doc, "div", "bolna-bp-head");
  const heading = element(doc, "span", "bolna-bp-title");
  heading.textContent = title;
  const status = element(doc, "span", "bolna-bp-status");
  head.append(heading, status);
  const detail = element(doc, "p", "bolna-bp-banner");
  detail.setAttribute("aria-live", "polite");
  const screenshot = element(doc, "img", "bolna-bp-shot");
  screenshot.alt = "What the browser sees";
  const steps = element(doc, "ol", "bolna-bp-steps");
  root.append(head, detail, screenshot, steps);
  container.append(root);

  // While the browser waits on the caller the status counts the wait, from the time the view reported.
  let waitTimer: ReturnType<typeof setInterval> | null = null;
  const stopWaitTimer = () => {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
  };

  const render = (view: BrowserView | null) => {
    const described = describeBrowserView(view);
    root.dataset.status = view?.status ?? "none";
    status.textContent = described.status;
    stopWaitTimer();
    if (view?.status === "waiting") {
      const since = Date.now() - (view.waiting_seconds ?? 0) * 1000;
      const tick = () => {
        status.textContent = `${described.status} · waiting ${formatWait((Date.now() - since) / 1000)}`;
      };
      tick();
      waitTimer = setInterval(tick, WAIT_TICK_MS);
    }
    detail.textContent = described.detail;
    detail.hidden = !described.detail;
    if (view?.screenshot_url) screenshot.src = view.screenshot_url;
    screenshot.hidden = !view?.screenshot_url;
    steps.replaceChildren(
      ...(view?.recent_actions ?? []).map((line) => {
        const item = doc.createElement("li");
        item.textContent = line;
        return item;
      }),
    );
    steps.hidden = steps.childElementCount === 0;
  };
  render(call.getBrowserView());
  call.on("browser-update", render);
  return () => {
    call.off("browser-update", render);
    stopWaitTimer();
    root.remove();
  };
}
