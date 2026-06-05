export type HarnessEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "session.saved"; sessionId: string }
  | { type: "model.requested"; turn: number }
  | { type: "model.responded"; turn: number; stopReason?: string }
  | { type: "tool.started"; id: string; name: string }
  | { type: "tool.finished"; id: string; name: string; isError: boolean }
  | { type: "context.compacted"; before: number; after: number }
  | { type: "agent.finished"; turns: number; toolCalls: number };

export type EventListener = (event: HarnessEvent) => void;

export class EventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

