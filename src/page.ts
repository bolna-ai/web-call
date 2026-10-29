import type {
  AttachPageOptions,
  BrowserStatus,
  BrowserViewAccess,
  PageField,
  PageFillError,
  PageFillUpdate,
} from "./types";

const POLL_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
// The caller's own typing reaches the agent once they pause.
const VALUES_DEBOUNCE_MS = 400;
const RESCAN_DEBOUNCE_MS = 300;
const DEFAULT_TYPING_DELAY_MS = 18;
// A long value types in larger chunks, so no field takes longer than this.
const MAX_TYPING_MS = 1_200;
const HIGHLIGHT_MS = 900;
// Without a submit option, how long the app has to say whether its own submit went through.
const REPORT_WAIT_MS = 15_000;
const MAX_FIELDS = 30;
const NAME_MAX_CHARS = 40;
const LABEL_MAX_CHARS = 120;
const NO_REPORT = "The page didn't say whether the form went through.";
// The agent hears the outcome as data, so the backend takes only an id-like reference and a short plain reason.
const REFERENCE_MAX_CHARS = 64;
const REASON_MAX_CHARS = 120;
// Never read or filled: passwords, payment cards, one-time codes and the like.
const SENSITIVE_NAME = /(pass(word|code)|card|cvv|cvc|otp|one.?time|\bpin\b|ssn|iban|account.?num|routing|security.?code)/i;
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const NEVER_INPUT_TYPES = new Set(["password", "hidden", "file", "submit", "button", "reset", "image"]);
const OPTION_BUTTONS = 'button, [role="button"], [role="radio"], [data-bolna-option]';
const FINISHED: ReadonlySet<BrowserStatus> = new Set(["done", "failed", "stopped"]);

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** One field of the form, as the agent sees it, with how to read and set it on the page. */
interface ScannedField {
  info: PageField;
  read(): string;
  apply(value: string, typingDelayMs: number, isActive: () => boolean): Promise<void>;
}

interface PageView {
  task_id: string;
  version: string;
  status: BrowserStatus;
  pending: Record<string, string>;
  pending_version: number;
  submit: { question_id: string; values: Record<string, string> } | null;
}

interface Outcome {
  submitted: boolean;
  reference?: string;
  error?: string;
}

class PageNotAttached extends Error {}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** A label as the agent should say it: without the asterisk forms put on required fields. */
function cleanLabel(text: string | null | undefined): string {
  return squash(text).replace(/\s*\*+$/, "");
}

function same(a: string, b: string): boolean {
  return squash(a).toLowerCase() === squash(b).toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A label's own words, leaving out the controls inside it (a select's options would otherwise read as label). */
function ownText(element: Element): string {
  let text = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text += child.textContent ?? "";
      else if (child instanceof Element && !child.matches("input, select, textarea, button, option")) walk(child);
    }
  };
  walk(element);
  return squash(text);
}

function labelledBy(element: Element): string {
  const ids = element.getAttribute("aria-labelledby");
  if (!ids) return "";
  return squash(ids.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
}

function labelOf(control: HTMLElement): string {
  const named = control.getAttribute("data-bolna-label") || control.getAttribute("aria-label") || labelledBy(control);
  if (named) return cleanLabel(named);
  if (control.id) {
    const label = Array.from(control.ownerDocument.getElementsByTagName("label")).find((l) => l.htmlFor === control.id);
    if (label && ownText(label)) return cleanLabel(ownText(label));
  }
  const wrapping = control.closest("label");
  if (wrapping && ownText(wrapping)) return cleanLabel(ownText(wrapping));
  return cleanLabel(control.getAttribute("placeholder") || control.getAttribute("name") || control.id);
}

/** The words for a group (radios, option buttons): its own label, else its fieldset's legend. */
function groupLabel(group: Element | null, fallback: string): string {
  if (group) {
    const named = group.getAttribute("data-bolna-label") || group.getAttribute("aria-label") || labelledBy(group);
    if (named) return cleanLabel(named);
  }
  const legend = group?.closest("fieldset")?.querySelector("legend");
  return cleanLabel(legend?.textContent) || fallback;
}

function isSensitive(control: HTMLElement): boolean {
  const autocomplete = (control.getAttribute("autocomplete") || "").toLowerCase();
  const names = `${control.getAttribute("name") ?? ""} ${control.id}`;
  return SENSITIVE_AUTOCOMPLETE.test(autocomplete) || SENSITIVE_NAME.test(names);
}

function isLeftOut(element: HTMLElement): boolean {
  return Boolean(element.closest('[data-bolna-ignore], [hidden], [aria-hidden="true"], [inert]'));
}

/** Sets a control's value the way a person typing would, so a React-controlled input notices: React tracks the
 *  value set through the element itself, and only an input event after the prototype's own setter reads as new. */
function setNativeValue(control: Control, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  if (setter) setter.call(control, value);
  else control.value = value;
}

function highlight(element: HTMLElement): () => void {
  const previous = element.style.outline;
  element.style.outline = "2px solid #22c55e";
  return () => {
    setTimeout(() => (element.style.outline = previous), HIGHLIGHT_MS);
  };
}

function textField(control: HTMLInputElement | HTMLTextAreaElement): Omit<ScannedField, "info"> {
  return {
    read: () => control.value,
    async apply(value, typingDelayMs, isActive) {
      if (control.value === value) return;
      const done = highlight(control);
      control.focus?.();
      const steps = typingDelayMs > 0 ? Math.max(1, Math.min(value.length, Math.floor(MAX_TYPING_MS / typingDelayMs))) : 1;
      for (let step = 1; step <= steps; step++) {
        setNativeValue(control, value.slice(0, Math.ceil((value.length * step) / steps)));
        control.dispatchEvent(new Event("input", { bubbles: true }));
        if (step < steps) {
          await sleep(typingDelayMs);
          if (!isActive()) break;
        }
      }
      control.dispatchEvent(new Event("change", { bubbles: true }));
      control.blur?.();
      done();
    },
  };
}

function selectField(control: HTMLSelectElement): Omit<ScannedField, "info"> {
  const chosen = () => Array.from(control.options).find((option) => option.selected && option.value !== "");
  return {
    read: () => squash(chosen()?.text),
    async apply(value) {
      const option = Array.from(control.options).find((o) => same(o.text, value) || same(o.value, value));
      if (!option || option.selected) return;
      const done = highlight(control);
      setNativeValue(control, option.value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      done();
    },
  };
}

function clickField(choices: { label: string; element: HTMLElement; picked: () => boolean }[]) {
  return {
    read: () => choices.find((choice) => choice.picked())?.label ?? "",
    async apply(value: string) {
      const choice = choices.find((c) => same(c.label, value));
      if (!choice || choice.picked()) return;
      const done = highlight(choice.element);
      choice.element.click();
      done();
    },
  };
}

function checkboxField(control: HTMLInputElement): Omit<ScannedField, "info"> {
  return {
    read: () => (control.checked ? "yes" : "no"),
    async apply(value) {
      if ((value === "yes") === control.checked) return;
      const done = highlight(control);
      control.click();
      done();
    },
  };
}

function pressed(button: Element): boolean {
  return ["aria-pressed", "aria-checked", "aria-selected", "data-bolna-selected"].some(
    (name) => button.getAttribute(name) === "true",
  );
}

/** The form's fields, in page order: text inputs, text areas, selects, radio groups, tick boxes, and rows of option
 *  buttons marked with data-bolna-field. Passwords, payment cards, one-time codes, hidden fields and anything inside
 *  data-bolna-ignore are left out. */
export function scanForm(form: HTMLElement): ScannedField[] {
  const fields: ScannedField[] = [];
  const names = new Set<string>();
  const radioGroups = new Set<string>();
  const add = (base: string, field: Omit<ScannedField, "info"> & { info: Omit<PageField, "name"> }) => {
    if (fields.length >= MAX_FIELDS) return;
    let name = fieldName(base);
    for (let n = 2; names.has(name); n++) name = `${fieldName(base).slice(0, NAME_MAX_CHARS - 3)}_${n}`;
    names.add(name);
    fields.push({ ...field, info: { ...field.info, name, label: field.info.label.slice(0, LABEL_MAX_CHARS) } });
  };

  for (const element of Array.from(form.querySelectorAll<HTMLElement>("input, select, textarea, [data-bolna-field]"))) {
    if (isLeftOut(element) || isSensitive(element)) continue;
    const declared = element.getAttribute("data-bolna-field") ?? "";
    const required = (element as Control).required || element.getAttribute("aria-required") === "true";

    if (element instanceof HTMLTextAreaElement) {
      if (element.disabled) continue;
      const label = labelOf(element);
      add(declared || element.name || label, { ...textField(element), info: base(label, "long_text", required) });
    } else if (element instanceof HTMLSelectElement) {
      if (element.disabled) continue;
      const options = Array.from(element.options).filter((o) => o.value !== "").map((o) => squash(o.text));
      if (!options.length) continue;
      const label = labelOf(element);
      add(declared || element.name || label, { ...selectField(element), info: { ...base(label, "choice", required), options } });
    } else if (element instanceof HTMLInputElement) {
      const type = (element.type || "text").toLowerCase();
      if (element.disabled || NEVER_INPUT_TYPES.has(type)) continue;
      if (type === "radio") {
        const group = element.name || element.id;
        if (radioGroups.has(group)) continue;
        radioGroups.add(group);
        const radios = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
          (radio) => (radio.name || radio.id) === group && !radio.disabled && !isLeftOut(radio),
        );
        const choices = radios.map((radio) => ({
          label: labelOf(radio) || radio.value,
          element: radio as HTMLElement,
          picked: () => radio.checked,
        }));
        const label = groupLabel(element.closest('[role="radiogroup"], fieldset'), element.name);
        const anyRequired = radios.some((radio) => radio.required);
        add(declared || element.name || label, {
          ...clickField(choices),
          info: { ...base(label, "choice", anyRequired), options: choices.map((c) => c.label) },
        });
      } else if (type === "checkbox") {
        const label = labelOf(element);
        add(declared || element.name || label, { ...checkboxField(element), info: base(label, "checkbox", required) });
      } else {
        const label = labelOf(element);
        add(declared || element.name || label, {
          ...textField(element),
          info: { ...base(label, "text", required), input_type: type === "text" ? "" : type },
        });
      }
    } else if (declared) {
      // A row of option buttons, such as "Yes / Not yet".
      const buttons = Array.from(element.querySelectorAll<HTMLElement>(OPTION_BUTTONS)).filter((b) => !isLeftOut(b));
      const choices = buttons.map((button) => ({
        label: squash(button.getAttribute("data-bolna-option") || button.textContent),
        element: button,
        picked: () => pressed(button),
      }));
      if (!choices.length) continue;
      const label = groupLabel(element, declared);
      add(declared, { ...clickField(choices), info: { ...base(label, "choice", required), options: choices.map((c) => c.label) } });
    }
  }
  return fields;
}

function base(label: string, kind: PageField["kind"], required: boolean): Omit<PageField, "name"> {
  return { label: label || "Field", kind, input_type: "", required, options: [] };
}

/** A field name the agent can send back: lowercase letters, digits and _, starting with a letter. */
export function fieldName(text: string): string {
  let name = trimUnderscores(text.toLowerCase().replace(/[^a-z0-9]+/g, "_")).slice(0, NAME_MAX_CHARS);
  if (!/^[a-z]/.test(name)) name = `field_${name}`.slice(0, NAME_MAX_CHARS);
  return trimUnderscores(name) || "field";
}

/** Underscores trimmed from both ends with a loop: a regex like /_+$/ backtracks on a page's long runs of them. */
function trimUnderscores(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === "_") start += 1;
  while (end > start && text[end - 1] === "_") end -= 1;
  return text.slice(start, end);
}

/** Fills one form on the caller's own page while they talk: it tells Bolna the form's fields, types what the
 *  agent sends, reports what the fields hold (the caller's own typing too), and submits only once the caller said
 *  yes to a read-back that still matches the page. */
export class PageFiller {
  private fields: ScannedField[] = [];
  private access: BrowserViewAccess | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delayMs = POLL_MS;
  private failing = false;
  private attached = false;
  private version = "";
  private appliedVersion = 0;
  private typing = false;
  private handledQuestion = "";
  private lastSchema = "";
  private lastPosted = "";
  private valuesTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private reportWaiter: ((outcome: Outcome) => void) | null = null;
  // An outcome Bolna hasn't taken yet. Only the report is retried: the form is never sent twice.
  private unsentOutcome: Record<string, unknown> | null = null;
  private readonly onCallerInput = () => {
    if (!this.typing) this.scheduleValues();
  };

  constructor(
    private readonly form: HTMLElement,
    private readonly options: AttachPageOptions,
    private readonly onUpdate: (update: PageFillUpdate) => void,
    private readonly onError: (error: PageFillError) => void,
  ) {}

  /** The form's fields as the agent sees them. */
  get fieldList(): PageField[] {
    return (this.fields.length ? this.fields : scanForm(this.form)).map((field) => field.info);
  }

  start(access: BrowserViewAccess): void {
    if (this.running) return;
    this.access = access;
    this.running = true;
    this.attached = false;
    this.version = "";
    this.appliedVersion = 0;
    this.handledQuestion = "";
    this.lastSchema = "";
    this.lastPosted = "";
    this.delayMs = POLL_MS;
    this.form.addEventListener("input", this.onCallerInput, true);
    this.form.addEventListener("change", this.onCallerInput, true);
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => this.scheduleRescan());
      this.observer.observe(this.form, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "disabled", "aria-hidden", "aria-pressed", "aria-checked", "aria-selected"],
      });
    }
    this.update({ state: "connecting" });
    this.schedule(0);
  }

  /** The call ended, or the app detached the form. */
  stop(): void {
    if (!this.running) return;
    this.halt();
    this.update({ state: "stopped" });
  }

  private halt(): void {
    this.running = false;
    for (const timer of [this.timer, this.valuesTimer, this.rescanTimer]) if (timer) clearTimeout(timer);
    this.timer = this.valuesTimer = this.rescanTimer = null;
    this.observer?.disconnect();
    this.observer = null;
    this.form.removeEventListener("input", this.onCallerInput, true);
    this.form.removeEventListener("change", this.onCallerInput, true);
    this.reportWaiter?.({ submitted: false, error: "The call ended before the page said." });
  }

  reportSubmitted(reference = ""): void {
    this.reportWaiter?.({ submitted: true, reference });
  }

  reportFailed(reason: string): void {
    this.reportWaiter?.({ submitted: false, error: reason || "The form wasn't sent." });
  }

  private update(update: PageFillUpdate): void {
    this.onUpdate(update);
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.running ? setTimeout(() => void this.poll(), delayMs) : null;
  }

  private async poll(): Promise<void> {
    this.timer = null;
    try {
      if (this.unsentOutcome) await this.sendOutcome();
      if (!this.attached) await this.attach();
      const view = await this.fetchView();
      if (!this.running) return;
      this.delayMs = POLL_MS;
      this.failing = false;
      if (view) await this.follow(view);
    } catch (err) {
      if (!this.running) return;
      if (err instanceof PageNotAttached) {
        // The fill ended or was never started: connect the form again.
        this.attached = false;
        this.version = "";
      } else {
        this.delayMs = Math.min(this.delayMs * 2, MAX_BACKOFF_MS);
        if (!this.failing) {
          this.failing = true;
          const reason = err instanceof Error ? err.message : String(err);
          this.onError({ code: "page_failed", message: `Couldn't reach Bolna for the page's form: ${reason}` });
        }
      }
    }
    if (this.running) this.schedule(this.delayMs);
  }

  private async follow(view: PageView): Promise<void> {
    this.version = view.version;
    if (view.pending_version > this.appliedVersion) {
      await this.typePending(view.pending, view.pending_version);
    }
    if (FINISHED.has(view.status)) {
      // Done: the outcome already shown stays.
      this.halt();
      return;
    }
    if (view.submit && view.submit.question_id !== this.handledQuestion) {
      this.handledQuestion = view.submit.question_id;
      await this.submit(view.submit.question_id, view.submit.values);
    } else if (!this.typing) {
      this.update({ state: view.status === "waiting" ? "confirming" : "ready" });
    }
  }

  private async typePending(pending: Record<string, string>, version: number): Promise<void> {
    this.typing = true;
    try {
      for (const field of this.fields) {
        if (!this.running) return;
        if (!(field.info.name in pending)) continue;
        this.update({ state: "typing", field: field.info.label });
        await field.apply(pending[field.info.name], this.options.typingDelayMs ?? DEFAULT_TYPING_DELAY_MS, () => this.running);
      }
    } finally {
      this.typing = false;
    }
    this.appliedVersion = version;
    await this.postValues(true);
  }

  private async submit(questionId: string, confirmed: Record<string, string>): Promise<void> {
    const values = this.values();
    const changed = Object.entries(confirmed).some(([name, value]) => !same(values[name] ?? "", value));
    if (changed) {
      this.unsentOutcome = { question_id: questionId, changed: true };
      this.update({ state: "ready", detail: "The form changed after the yes, so it is read back again." });
      await this.sendOutcome();
      return;
    }
    this.update({ state: "submitting" });
    let outcome: Outcome;
    try {
      if (this.options.submit) {
        const result = await this.options.submit(values);
        outcome = { submitted: true, reference: result?.reference ?? "" };
      } else {
        outcome = await this.submitThroughPage();
      }
    } catch (err) {
      outcome = { submitted: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.unsentOutcome = {
      question_id: questionId,
      submitted: outcome.submitted,
      reference: referenceId(outcome.reference ?? ""),
      error: (outcome.error ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX_CHARS),
    };
    this.update(
      outcome.submitted
        ? { state: "submitted", detail: outcome.reference ?? "" }
        : { state: "not_submitted", detail: outcome.error ?? "" },
    );
    if (this.running) await this.sendOutcome();
  }

  private async sendOutcome(): Promise<void> {
    const outcome = this.unsentOutcome;
    if (!outcome) return;
    await this.post("page/outcome", outcome);
    this.unsentOutcome = null;
  }

  /** The form's own submit, as its button would do it. The app says how it went with reportSubmitted or
   *  reportFailed; a form that leaves the page needs the submit option instead. */
  private submitThroughPage(): Promise<Outcome> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => finish({ submitted: false, error: NO_REPORT }), REPORT_WAIT_MS);
      const finish = (outcome: Outcome) => {
        clearTimeout(timeout);
        this.reportWaiter = null;
        resolve(outcome);
      };
      this.reportWaiter = finish;
      if (this.form instanceof HTMLFormElement && typeof this.form.requestSubmit === "function") {
        // An invalid form never fires submit, so the app would never get to say: say why here instead.
        const invalid = Array.from(this.form.elements).find(
          (element): element is Control => "checkValidity" in element && !(element as Control).checkValidity(),
        );
        if (invalid) {
          finish({ submitted: false, error: `The page refused ${labelOf(invalid)}: ${invalid.validationMessage}` });
          return;
        }
        this.form.requestSubmit();
      } else {
        this.form.querySelector<HTMLElement>('[type="submit"], button:not([type="button"])')?.click();
      }
    });
  }

  private values(): Record<string, string> {
    return Object.fromEntries(this.fields.map((field) => [field.info.name, field.read()]));
  }

  private scheduleValues(): void {
    if (this.valuesTimer) clearTimeout(this.valuesTimer);
    this.valuesTimer = setTimeout(() => {
      this.valuesTimer = null;
      void this.postValues(false).catch(() => {});
    }, VALUES_DEBOUNCE_MS);
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan().catch(() => {});
    }, RESCAN_DEBOUNCE_MS);
  }

  /** Fields shown or hidden since the last scan reach Bolna; a button pressed by the caller reads as typing. */
  private async rescan(): Promise<void> {
    if (!this.running || !this.attached) return;
    const fields = scanForm(this.form);
    if (JSON.stringify(fields.map((field) => field.info)) !== this.lastSchema) await this.attach(fields);
    if (!this.typing) await this.postValues(false);
  }

  private async attach(fields = scanForm(this.form)): Promise<void> {
    if (!fields.length) throw new Error("the form has no fields to fill");
    this.fields = fields;
    this.lastSchema = JSON.stringify(fields.map((field) => field.info));
    await this.post("page/attach", { page_url: location.href, fields: fields.map((field) => field.info) });
    if (!this.attached) this.update({ state: "ready" });
    this.attached = true;
  }

  private async postValues(force: boolean): Promise<void> {
    if (!this.running || !this.attached) return;
    const body = { applied_version: this.appliedVersion, values: this.values() };
    const serialized = JSON.stringify(body);
    if (!force && serialized === this.lastPosted) return;
    this.lastPosted = serialized;
    await this.post("page/values", body);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await this.request(path, body);
    if (!response.ok) throw new Error(await this.reason(response));
  }

  private async fetchView(): Promise<PageView | null> {
    const response = await this.request(`page${this.version ? `?since=${encodeURIComponent(this.version)}` : ""}`);
    if (response.status === 204) return null;
    if (response.status === 404) throw new PageNotAttached();
    if (!response.ok) throw new Error(await this.reason(response));
    return (await response.json()) as PageView;
  }

  private async request(path: string, body?: unknown): Promise<Response> {
    const access = this.access!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${access.api_base_url.replace(/\/+$/, "")}/browser-agent/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${access.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async reason(response: Response): Promise<string> {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return body.message || `HTTP ${response.status}`;
  }
}

/** The reference as the backend takes it: letters, digits and . _ / # : -, starting with a letter or digit. */
export function referenceId(reference: string): string {
  return reference
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._/#:-]/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, REFERENCE_MAX_CHARS);
}
