import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserWatcher } from "../src/browser";
import type { BrowserView, BrowserViewError } from "../src/types";
import { browserView, failNetwork, serveBrowserView } from "./support/view-server";

const ACCESS = { token: "bvt_key", api_base_url: "https://api.example.com/" };

function watch() {
  const updates: BrowserView[] = [];
  const errors: BrowserViewError[] = [];
  const watcher = new BrowserWatcher(
    ACCESS,
    (view) => updates.push(view),
    (error) => errors.push(error),
  );
  return { watcher, updates, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("BrowserWatcher", () => {
  it("asks for the call's view with its key and reports a new view with its screenshot", async () => {
    const server = serveBrowserView([browserView(), 204]);
    const { watcher, updates } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "running", progress: "Typing the name" });
    expect(updates[0].screenshot_url).toMatch(/^blob:/);
    expect(watcher.view).toBe(updates[0]);
    expect(server.requests[0]).toEqual({
      url: "https://api.example.com/browser-agent/view",
      authorization: "Bearer bvt_key",
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(server.viewUrls()[1]).toBe("https://api.example.com/browser-agent/view?since=1");
    watcher.stop();
  });

  it("looks at the screenshot once more after each change, since the browser saves it just after the step", async () => {
    const server = serveBrowserView([browserView(), 204]);
    const { watcher, updates } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(server.screenshotCount()).toBe(2);
    expect(updates).toHaveLength(2);
    expect(updates[1].screenshot_url).not.toBe(updates[0].screenshot_url);
    expect(updates[1].version).toBe("1");
    watcher.stop();
  });

  it("without a screenshot yet, the view has none", async () => {
    serveBrowserView([browserView({ status: "queued" }), 204], 204);
    const { watcher, updates } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(updates).toHaveLength(1);
    expect(updates[0].screenshot_url).toBeNull();
    watcher.stop();
  });

  it("stops for good, saying so once, when the call's key is no longer valid", async () => {
    const server = serveBrowserView([404]);
    const { watcher, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(errors).toEqual([expect.objectContaining({ code: "view_expired" })]);
    expect(server.viewUrls()).toHaveLength(1);
  });

  it("backs off while requests fail and reports the failing streak once", async () => {
    const server = serveBrowserView([429, 429, 503, browserView(), 204]);
    const { watcher, updates, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0); // 429, next in 3 s
    await vi.advanceTimersByTimeAsync(2_999);
    expect(server.viewUrls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); // 429, next in 6 s
    await vi.advanceTimersByTimeAsync(6_000); // 503, next in 12 s
    expect(server.viewUrls()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12_000); // the view
    expect(updates).toHaveLength(1);
    expect(errors).toEqual([expect.objectContaining({ code: "view_unavailable" })]);

    await vi.advanceTimersByTimeAsync(1_500); // back to the normal pace
    expect(server.viewUrls()).toHaveLength(5);
    watcher.stop();
  });

  it("treats a network failure like any failed request", async () => {
    failNetwork();
    const { watcher, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      { code: "view_unavailable", message: "Couldn't load the browser view: fake network failure" },
    ]);
    watcher.stop();
  });

  it("frees a screenshot once a newer one replaces it", async () => {
    serveBrowserView([browserView(), 204]);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { watcher, updates } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(revoke).toHaveBeenCalledWith(updates[0].screenshot_url);
    expect(revoke).not.toHaveBeenCalledWith(updates[1].screenshot_url);
    watcher.stop();
    revoke.mockRestore();
  });

  it("keeps the last screenshot usable once stopped, until it is released", async () => {
    serveBrowserView([browserView(), 204]);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { watcher } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    const shown = watcher.view!.screenshot_url;
    watcher.stop();
    expect(revoke).not.toHaveBeenCalledWith(shown);

    watcher.release();
    expect(revoke).toHaveBeenCalledWith(shown);
    revoke.mockRestore();
  });

  it.each([
    ["the view", ["hang"] as const, "image" as const],
    ["the screenshot", [browserView()], "hang" as const],
  ])("stopped while %s is loading, it reports nothing and keeps no screenshot", async (_label, replies, screenshot) => {
    serveBrowserView([...replies], screenshot);
    const create = vi.spyOn(URL, "createObjectURL");
    const { watcher, updates, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(updates).toEqual([]);
    expect(errors).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it("gives up on a request that hangs for 10 s, then tries again", async () => {
    const server = serveBrowserView(["hang", browserView(), 204]);
    const { watcher, updates, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([expect.objectContaining({ code: "view_unavailable" })]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(updates).toHaveLength(1);
    expect(server.viewUrls()).toHaveLength(2);
    watcher.stop();
  });

  it("reports a new failing streak again after a success", async () => {
    serveBrowserView([429, browserView(), 429, 204]);
    const { watcher, errors } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0); // 429
    await vi.advanceTimersByTimeAsync(3_000); // the view
    await vi.advanceTimersByTimeAsync(1_500); // 429 again

    expect(errors.map((error) => error.code)).toEqual(["view_unavailable", "view_unavailable"]);
    watcher.stop();
  });

  it("once the call ends, stops at once if the outcome is already in", async () => {
    const server = serveBrowserView([browserView({ status: "done", submitted: true, reference: "Order 42" }), 204]);
    const { watcher } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.finish();
    const asked = server.requests.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.requests).toHaveLength(asked);
  });

  it("asks nothing more once stopped", async () => {
    const server = serveBrowserView([browserView(), 204]);
    const { watcher } = watch();

    watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();
    const asked = server.requests.length;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.requests).toHaveLength(asked);
  });
});
