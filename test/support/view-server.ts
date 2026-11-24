// A stand-in for Bolna's browser view endpoints. Each GET /browser-agent/view answers with the next scripted reply
// (the last one repeats); the screenshot endpoint answers with an image or a bare status. Replies are plain
// objects, like browser-env's fetch, so fake timers never wait on a real body stream.
import { vi } from "vitest";

/** A view body (served as 200), a bare status code, or "hang": no answer until the request is aborted. */
export type ViewReply = Record<string, unknown> | number | "hang";

export interface ViewRequest {
  url: string;
  authorization: string | null;
}

export function browserView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1",
    status: "running",
    kind: "form_fill",
    step: 1,
    progress: "Typing the name",
    recent_actions: ["Opened httpbin.org"],
    awaiting: "none",
    question: "",
    confirm_summary: "",
    waiting_seconds: 0,
    submitted: false,
    reference: "",
    answer: "",
    error: "",
    ...overrides,
  };
}

function hang(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("The request was aborted", "AbortError")));
  });
}

function reply(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => body,
  };
}

export function serveBrowserView(replies: ViewReply[], screenshot: number | "image" | "hang" = "image") {
  const requests: ViewRequest[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
      requests.push({ url, authorization: init?.headers?.Authorization ?? null });
      if (url.includes("/browser-agent/view/screenshot")) {
        if (screenshot === "hang") return hang(init?.signal);
        return screenshot === "image"
          ? reply(200, new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }))
          : reply(screenshot);
      }
      if (!url.includes("/browser-agent/view")) throw new TypeError(`unexpected request to ${url}`);
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next === "hang") return hang(init?.signal);
      return typeof next === "number" ? reply(next) : reply(200, next);
    }),
  );
  return {
    requests,
    viewUrls: () => requests.filter((r) => !r.url.includes("/screenshot")).map((r) => r.url),
    screenshotCount: () => requests.filter((r) => r.url.includes("/screenshot")).length,
  };
}

export function failNetwork(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fake network failure");
    }),
  );
}
