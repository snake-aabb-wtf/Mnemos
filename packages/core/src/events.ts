import type { ContextStats } from "./context.js";
import type { HistoryMessage } from "./contracts.js";

export interface HarnessEventMap {
  "message.received": { message: HistoryMessage };
  "message.generated": { message: HistoryMessage };
  "context.pressure": { sessionId: string; stats: ContextStats };
  "context.compaction.requested": {
    sessionId: string;
    stats: ContextStats;
    reason: "high" | "emergency";
  };
}

type Listener<T> = (payload: T) => void | Promise<void>;

/** A process-local event bus. Persistent event delivery is deliberately deferred past Phase 1. */
export class EventBus<Events extends object = HarnessEventMap> {
  private readonly listeners = new Map<keyof Events, Set<Listener<Events[keyof Events]>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener as Listener<Events[keyof Events]>);
    this.listeners.set(event, current);
    return () => current.delete(listener as Listener<Events[keyof Events]>);
  }

  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) await listener(payload);
  }
}
