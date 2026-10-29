// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fieldName, PageFiller, referenceId, scanForm } from "../src/page";
import type { PageFillError, PageFillUpdate } from "../src/types";
import { servePageFill } from "./support/page-server";

const ACCESS = { token: "bvt_key", api_base_url: "https://api.example.com/" };

const APPLICATION = `
  <form id="apply">
    <label for="name">Full name *</label><input id="name" name="full_name" required>
    <label>Email <input type="email" name="email"></label>
    <label>City <select name="city"><option value="">Pick one</option><option>Bangalore</option><option>Pune</option></select></label>
    <fieldset><legend>Applying as</legend>
      <label><input type="radio" name="team_size" value="solo"> Solo</label>
      <label><input type="radio" name="team_size" value="team"> Team</label>
    </fieldset>
    <div data-bolna-field="idea_decided" aria-label="Decided on your idea?">
      <button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">Not yet</button>
    </div>
    <label><textarea name="idea"></textarea> What are you building?</label>
    <label><input type="checkbox" name="contact_consent" required> I agree to be contacted</label>
    <label>Password <input type="password" name="pw"></label>
    <label>Card number <input name="card_number"></label>
    <div data-bolna-ignore><label>Referral code <input name="referral"></label></div>
    <input type="hidden" name="csrf" value="x">
    <button>Apply</button>
  </form>`;

function mountApplication(): HTMLFormElement {
  document.body.innerHTML = APPLICATION;
  const form = document.getElementById("apply") as HTMLFormElement;
  // The option buttons behave like a React component: a click presses one and releases the other.
  const buttons = Array.from(form.querySelectorAll<HTMLButtonElement>("[data-bolna-field] button"));
  for (const button of buttons) {
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
    });
  }
  return form;
}

function filler(form: HTMLElement, options = {}) {
  const updates: PageFillUpdate[] = [];
  const errors: PageFillError[] = [];
  const page = new PageFiller(
    form,
    { typingDelayMs: 0, ...options },
    (update) => updates.push(update),
    (error) => errors.push(error),
  );
  return { page, updates, errors };
}

const field = (form: HTMLElement, name: string) => form.querySelector(`[name="${name}"]`) as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("scanForm", () => {
  it("finds every field a person would fill, in page order, and leaves out the sensitive and hidden ones", () => {
    const fields = scanForm(mountApplication()).map((f) => f.info);

    expect(fields.map((f) => [f.name, f.label, f.kind])).toEqual([
      ["full_name", "Full name", "text"],
      ["email", "Email", "text"],
      ["city", "City", "choice"],
      ["team_size", "Applying as", "choice"],
      ["idea_decided", "Decided on your idea?", "choice"],
      ["idea", "What are you building?", "long_text"],
      ["contact_consent", "I agree to be contacted", "checkbox"],
    ]);
    expect(fields[0].required).toBe(true);
    expect(fields[1].input_type).toBe("email");
    expect(fields[2].options).toEqual(["Bangalore", "Pune"]);
    expect(fields[3].options).toEqual(["Solo", "Team"]);
    expect(fields[4].options).toEqual(["Yes", "Not yet"]);
  });

  it("reads what each field holds the way the agent sends it", async () => {
    const form = mountApplication();
    const fields = Object.fromEntries(scanForm(form).map((f) => [f.info.name, f]));

    for (const [name, value] of Object.entries({
      full_name: "Asha Rao",
      city: "pune",
      team_size: "Team",
      idea_decided: "Not yet",
      contact_consent: "yes",
    })) {
      await fields[name].apply(value, 0, () => true);
    }

    expect(Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.read()]))).toEqual({
      full_name: "Asha Rao",
      email: "",
      city: "Pune",
      team_size: "Team",
      idea_decided: "Not yet",
      idea: "",
      contact_consent: "yes",
    });
  });

  it("names fields so the agent can send them back", () => {
    expect(fieldName("What's your LinkedIn?")).toBe("what_s_your_linkedin");
    expect(fieldName("2nd address")).toBe("field_2nd_address");
    expect(fieldName("")).toBe("field");
    expect(fieldName("__Email__")).toBe("email");
    expect(fieldName("_".repeat(50_000) + "x")).toBe("x");
    expect(fieldName("a" + "!".repeat(50_000))).toBe("a");
  });
});

describe("typing into a React-controlled input", () => {
  it("sets the value so React's change tracking sees it", async () => {
    document.body.innerHTML = `<form><label>Full name <input name="full_name"></label></form>`;
    const input = document.querySelector("input")!;
    // React keeps the last value it saw in a setter on the element itself; a value set through that setter looks
    // unchanged to React, so its onChange never fires.
    let tracked = "";
    const prototypeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(input, "value", {
      get: () => prototypeValue.get!.call(input),
      set: (value: string) => {
        tracked = value;
        prototypeValue.set!.call(input, value);
      },
      configurable: true,
    });
    const reactChanges: string[] = [];
    input.addEventListener("input", () => {
      if (input.value !== tracked) {
        tracked = input.value;
        reactChanges.push(input.value);
      }
    });
    const [scanned] = scanForm(document.querySelector("form")!);

    const typed = scanned.apply("Asha Rao", 10, () => true);
    await vi.advanceTimersByTimeAsync(2_000);
    await typed;

    expect(input.value).toBe("Asha Rao");
    expect(reactChanges.at(-1)).toBe("Asha Rao");
    // It types in, so the caller sees it appear.
    expect(reactChanges.length).toBeGreaterThan(1);
  });
});

describe("PageFiller", () => {
  it("connects the form, types what the agent sends and reports what the page holds", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const { page, updates } = filler(form);

    page.start(ACCESS);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.bolna.attaches[0].page_url).toBe(location.href);
    expect(server.bolna.attaches[0].fields).toHaveLength(7);
    expect(server.bolna.authorizations[0]).toBe("Bearer bvt_key");

    server.send({ full_name: "Asha Rao", team_size: "Solo" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(field(form, "full_name").value).toBe("Asha Rao");
    expect((form.querySelector('[value="solo"]') as HTMLInputElement).checked).toBe(true);
    expect(server.bolna.values.at(-1)).toMatchObject({
      applied_version: 1,
      values: { full_name: "Asha Rao", team_size: "Solo", email: "" },
    });
    expect(updates.map((u) => u.state)).toContain("typing");
    page.stop();
  });

  it("tells the agent what the caller types themselves, once they pause", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const { page } = filler(form);
    page.start(ACCESS);
    await vi.advanceTimersByTimeAsync(0);

    field(form, "email").value = "asha@example.com";
    field(form, "email").dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(500);

    expect(server.bolna.values.at(-1)?.values.email).toBe("asha@example.com");
    page.stop();
  });

  it("submits only after the caller's yes, with the values they confirmed", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const submit = vi.fn(async () => ({ reference: "APP-1041" }));
    const { page, updates } = filler(form, { submit });
    page.start(ACCESS);
    server.send({ full_name: "Asha Rao", contact_consent: "yes" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(submit).not.toHaveBeenCalled();

    const confirmed = server.bolna.values.at(-1)!.values;
    server.approve("q1-ab12", confirmed);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(confirmed);
    expect(server.bolna.outcomes).toEqual([
      { question_id: "q1-ab12", submitted: true, reference: "APP-1041", error: "" },
    ]);
    // The fill is over: polling stops and the outcome stays the last thing shown.
    expect(updates.at(-1)).toEqual({ state: "submitted", detail: "APP-1041" });
    const asked = server.bolna.authorizations.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.bolna.authorizations).toHaveLength(asked);
  });

  it("doesn't submit a form that changed after the yes, and asks for a new read-back", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const submit = vi.fn(async () => ({}));
    const { page } = filler(form, { submit });
    page.start(ACCESS);
    server.send({ full_name: "Asha Rao" });
    await vi.advanceTimersByTimeAsync(1_000);

    server.approve("q1-ab12", { ...server.bolna.values.at(-1)!.values, full_name: "Asha R." });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(submit).not.toHaveBeenCalled();
    expect(server.bolna.outcomes).toEqual([{ question_id: "q1-ab12", changed: true }]);
    page.stop();
  });

  it("without a submit option, presses the form's own submit and waits for the app to say how it went", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const { page } = filler(form);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      setTimeout(() => page.reportSubmitted("APP-7"), 200);
    });
    page.start(ACCESS);
    server.send({ full_name: "Asha Rao", contact_consent: "yes" });
    await vi.advanceTimersByTimeAsync(1_000);

    server.approve("q1-ab12", server.bolna.values.at(-1)!.values);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(server.bolna.outcomes).toEqual([{ question_id: "q1-ab12", submitted: true, reference: "APP-7", error: "" }]);
  });

  it("says which field the page itself refused instead of waiting on a submit that never fires", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const { page } = filler(form);
    page.start(ACCESS);
    server.send({ contact_consent: "yes" });
    await vi.advanceTimersByTimeAsync(1_000);

    server.approve("q1-ab12", server.bolna.values.at(-1)!.values);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.bolna.outcomes[0]).toMatchObject({
      submitted: false,
      error: expect.stringContaining("The page refused Full name"),
    });
  });

  it("says when the app never reported its own submit", async () => {
    const server = servePageFill();
    const form = mountApplication();
    form.addEventListener("submit", (event) => event.preventDefault());
    const { page } = filler(form);
    page.start(ACCESS);
    server.send({ full_name: "Asha Rao", contact_consent: "yes" });
    await vi.advanceTimersByTimeAsync(1_000);

    server.approve("q1-ab12", server.bolna.values.at(-1)!.values);
    await vi.advanceTimersByTimeAsync(17_000);

    expect(server.bolna.outcomes[0]).toMatchObject({ submitted: false, error: expect.stringContaining("didn't say") });
  });

  it("retries a lost outcome report without sending the form again", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const submit = vi.fn(async () => ({ reference: "APP-1" }));
    const { page } = filler(form, { submit });
    server.bolna.failOutcomes = 1;
    page.start(ACCESS);
    await vi.advanceTimersByTimeAsync(0);

    server.approve("q1-ab12", server.bolna.values.at(-1)?.values ?? {});
    await vi.advanceTimersByTimeAsync(5_000);

    expect(submit).toHaveBeenCalledOnce();
    expect(server.bolna.outcomes).toEqual([{ question_id: "q1-ab12", submitted: true, reference: "APP-1", error: "" }]);
  });

  it("tells Bolna when fields appear, as a choice reveals them", async () => {
    const server = servePageFill();
    const form = mountApplication();
    const { page } = filler(form);
    page.start(ACCESS);
    await vi.advanceTimersByTimeAsync(0);

    form.insertAdjacentHTML("beforeend", `<label>Team name <input name="team_name"></label>`);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(server.bolna.attaches).toHaveLength(2);
    expect(server.bolna.attaches[1].fields.map((f) => f.name)).toContain("team_name");
    page.stop();
  });

  it("keeps going when Bolna can't be reached, and says so once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const { page, errors } = filler(mountApplication());

    page.start(ACCESS);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("page_failed");
    page.stop();
  });
});

describe("referenceId", () => {
  it("keeps an id-like reference", () => {
    expect(referenceId("APP-1041")).toBe("APP-1041");
    expect(referenceId("REF-88/23#4")).toBe("REF-88/23#4");
  });

  it("turns a sentence into a short id the backend accepts", () => {
    const id = referenceId("  Your reference: ABC 123 <b>ok</b> " + "x".repeat(100));
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,63}$/);
    expect(id.startsWith("Your-reference:-ABC-123-bok/b")).toBe(true);
  });

  it("is empty when nothing id-like is left", () => {
    expect(referenceId(" -- <> ")).toBe("");
  });
});
