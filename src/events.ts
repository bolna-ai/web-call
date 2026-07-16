/** Minimal typed event emitter — no dependency, listener errors never break the SDK. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export class Emitter<Events extends { [K in keyof Events]: Listener }> {
  private listeners = new Map<keyof Events, Set<Listener>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper as Events[K]);
      listener(...args);
    };
    return this.on(event, wrapper as Events[K]);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch (err) {
        // a throwing consumer callback must not take down call handling
        console.error("[bolna-web-call] listener error", err);
      }
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
