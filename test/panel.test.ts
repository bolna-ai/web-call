// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserWatcher } from "../src/browser";
import type { BolnaWebCall } from "../src/call";
import { Emitter } from "../src/events";
import { mountBrowserPanel } from "../src/panel";
import type { BolnaWebCallEvents, BrowserView } from "../src/types";
import { browserView, serveBrowserView } from "./support/view-server";

/** The two things the panel reads from a call: its latest view and browser-update. */
class FakeCall extends Emitter<BolnaWebCallEvents> {
  private latest: BrowserView | null = null;

  getBrowserView(): BrowserView | null {
    return this.latest;
  }

  push(overrides: Record<string, unknown>): void {
    this.latest = { ...(browserView(overrides) as unknown as BrowserView), screenshot_url: null, ...overrides };
    this.emit("browser-update", this.latest);
  }
}

function mount(call: FakeCall, options = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = mountBrowserPanel(call as unknown as BolnaWebCall, container, options);
  const part = (selector: string) => container.querySelector(selector) as HTMLElement;
  return { container, unmount, part };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("mountBrowserPanel", () => {
  it("before the browser starts, says so and shows nothing else", () => {
    const { part } = mount(new FakeCall());

    expect(part(".bolna-bp-title").textContent).toBe("Browser");
    expect(part(".bolna-bp-status").textContent).toBe("Not started");
    expect(part(".bolna-bp-banner").hidden).toBe(true);
    expect(part(".bolna-bp-shot").hidden).toBe(true);
    expect(part(".bolna-bp-steps").hidden).toBe(true);
  });

  it("shows the read-back the caller is asked to confirm, the screenshot and the step lines", () => {
    const call = new FakeCall();
    const { part } = mount(call);

    call.push({
      status: "waiting",
      awaiting: "confirmation",
      confirm_summary: "Customer name: Asha Rao; Pizza Size: Large",
      recent_actions: ["Typed into 'Customer name:'", "Clicked 'Large'"],
      screenshot_url: "blob:https://app.example/1",
    });

    expect(part(".bolna-bp").dataset.status).toBe("waiting");
    expect(part(".bolna-bp-status").textContent).toBe("Please confirm · waiting 0:00");
    expect(part(".bolna-bp-banner").textContent).toBe("Customer name: Asha Rao; Pizza Size: Large");
    expect((part(".bolna-bp-shot") as HTMLImageElement).src).toBe("blob:https://app.example/1");
    expect([...part(".bolna-bp-steps").children].map((item) => item.textContent)).toEqual([
      "Typed into 'Customer name:'",
      "Clicked 'Large'",
    ]);
  });

  it("counts how long the browser has waited on the caller, from what the view reported, and stops when it moves on", () => {
    vi.useFakeTimers();
    try {
      const call = new FakeCall();
      const { part, unmount } = mount(call);

      call.push({ status: "waiting", awaiting: "answer", question: "Which size?", waiting_seconds: 40 });
      expect(part(".bolna-bp-status").textContent).toBe("Needs your answer · waiting 0:40");
      vi.advanceTimersByTime(25_000);
      expect(part(".bolna-bp-status").textContent).toBe("Needs your answer · waiting 1:05");

      call.push({ status: "running", progress: "Typing the size" });
      vi.advanceTimersByTime(5_000);
      expect(part(".bolna-bp-status").textContent).toBe("Working");

      call.push({ status: "waiting", awaiting: "answer", question: "Which time?", waiting_seconds: 0 });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ status: "waiting", awaiting: "answer", question: "Which size?" }, "Needs your answer · waiting 0:00", "Which size?"],
    [{ status: "running", progress: "Typing the email" }, "Working", "Typing the email"],
    [{ status: "done", submitted: true, reference: "Order 42" }, "Submitted", "Order 42"],
    [{ status: "done", submitted: false, answer: "The site asks for an OTP." }, "Not submitted", "The site asks for an OTP."],
    [{ status: "done", kind: "lookup", answer: "It opened in 1889." }, "Done", "It opened in 1889."],
    [{ status: "failed", error: "ran out of time" }, "Couldn't finish", "ran out of time"],
    [{ status: "stopped", error: "call ended" }, "Stopped", "call ended"],
  ])("tells the caller where things stand: %o", (view, status, detail) => {
    const call = new FakeCall();
    const { part } = mount(call);

    call.push(view);

    expect(part(".bolna-bp-status").textContent).toBe(status);
    expect(part(".bolna-bp-banner").textContent).toBe(detail);
    expect(part(".bolna-bp-banner").hidden).toBe(false);
  });

  it("puts page text in as text, never as markup", () => {
    const call = new FakeCall();
    const { container, part } = mount(call);
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

    call.push({ progress: hostile, recent_actions: [hostile] });

    expect(part(".bolna-bp-banner").textContent).toBe(hostile);
    expect(part(".bolna-bp-steps").textContent).toBe(hostile);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelectorAll("script")).toHaveLength(0);
  });

  it("shows a view the call already has when it is mounted late", () => {
    const call = new FakeCall();
    call.push({ status: "waiting", awaiting: "answer", question: "Which size?" });

    const { part } = mount(call);

    expect(part(".bolna-bp-banner").textContent).toBe("Which size?");
  });

  it("styles itself inside a shadow root, which a page's styles don't reach", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    shadow.append(container);

    mountBrowserPanel(new FakeCall() as unknown as BolnaWebCall, container);

    expect(shadow.querySelector("style#bolna-browser-panel-style")).not.toBeNull();
    expect(document.head.querySelector("style#bolna-browser-panel-style")).toBeNull();
  });

  it("removes itself and stops listening when unmounted, and installs its style once", () => {
    const call = new FakeCall();
    const on = vi.spyOn(call, "on");
    const off = vi.spyOn(call, "off");
    const first = mount(call, { title: "Your application" });
    const second = mount(call);

    expect(first.part(".bolna-bp-title").textContent).toBe("Your application");
    expect(document.head.querySelectorAll("style#bolna-browser-panel-style")).toHaveLength(1);

    first.unmount();
    second.unmount();

    expect(document.querySelector(".bolna-bp")).toBeNull();
    expect(off.mock.calls).toEqual(on.mock.calls);
  });
});

describe("BrowserWatcher in a page", () => {
  let hidden = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("pauses while the tab is hidden and looks again as soon as it is shown", async () => {
    const server = serveBrowserView([browserView(), 204]);
    const watcher = new BrowserWatcher(
      { token: "bvt_key", api_base_url: "https://api.example.com" },
      () => {},
      () => {},
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const beforeHiding = server.viewUrls().length;

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.viewUrls()).toHaveLength(beforeHiding);

    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.viewUrls()).toHaveLength(beforeHiding + 1);
    watcher.stop();
  });

  it("never runs two requests at once when the tab is shown again mid-request", async () => {
    const server = serveBrowserView(["hang"]);
    const watcher = new BrowserWatcher(
      { token: "bvt_key", api_base_url: "https://api.example.com" },
      () => {},
      () => {},
    );
    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(server.viewUrls()).toHaveLength(1);
    watcher.stop();
  });
});
