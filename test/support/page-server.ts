// A stand-in for Bolna's page-fill endpoints: it keeps what the page attached and reported, and the test plays the
// agent by sending values and the caller's yes. Replies are plain objects, like view-server's.
import { vi } from "vitest";

interface Submit {
  question_id: string;
  values: Record<string, string>;
}

function reply(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

export function servePageFill() {
  const bolna = {
    attaches: [] as { page_url: string; fields: Record<string, unknown>[] }[],
    values: [] as { applied_version: number; values: Record<string, string> }[],
    outcomes: [] as Record<string, unknown>[],
    authorizations: [] as (string | null)[],
    pending: {} as Record<string, string>,
    pendingVersion: 0,
    submit: null as Submit | null,
    status: "running",
    // Outcome reports to refuse with a 500 before taking one.
    failOutcomes: 0,
  };
  const version = () => `${bolna.pendingVersion}:${bolna.submit?.question_id ?? ""}:${bolna.status}`;
  const view = () => ({
    task_id: "task-1",
    version: version(),
    status: bolna.status,
    pending: bolna.pending,
    pending_version: bolna.pendingVersion,
    submit: bolna.submit,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      bolna.authorizations.push(init?.headers?.Authorization ?? null);
      const path = url.split("/browser-agent/")[1];
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (path === "page/attach") {
        bolna.attaches.push(body);
        return reply(200, view());
      }
      if (path === "page/values") {
        bolna.values.push(body);
        if (body.applied_version >= bolna.pendingVersion) bolna.pending = {};
        return reply(204);
      }
      if (path === "page/outcome") {
        if (bolna.failOutcomes > 0) {
          bolna.failOutcomes -= 1;
          return reply(500, { message: "try again" });
        }
        bolna.outcomes.push(body);
        if (body.changed) bolna.submit = null;
        else bolna.status = "done";
        return reply(204);
      }
      if (path.startsWith("page")) {
        const since = new URL(url).searchParams.get("since");
        return since === version() ? reply(204) : reply(200, view());
      }
      throw new TypeError(`unexpected request to ${url}`);
    }),
  );
  return {
    bolna,
    /** The agent sends values for the page to type. */
    send(values: Record<string, string>) {
      bolna.pending = { ...bolna.pending, ...values };
      bolna.pendingVersion += 1;
    },
    /** The caller said yes to a read-back of these values. */
    approve(questionId: string, values: Record<string, string>) {
      bolna.submit = { question_id: questionId, values };
    },
  };
}
