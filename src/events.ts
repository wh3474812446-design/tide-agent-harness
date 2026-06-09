export type HarnessEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "session.saved"; sessionId: string }
  | { type: "model.requested"; turn: number }
  | { type: "model.responded"; turn: number; stopReason?: string }
  | { type: "model.delta"; turn: number; text: string }
  | { type: "model.usage"; turn: number; inputTokens: number; outputTokens: number }
  | { type: "tool.started"; id: string; name: string }
  | { type: "tool.finished"; id: string; name: string; isError: boolean }
  | { type: "context.compacted"; before: number; after: number }
  | { type: "todos.updated"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { type: "agent.finished"; turns: number; toolCalls: number; inputTokens: number; outputTokens: number }
  | { type: "mcp.connecting"; server: string }
  | { type: "mcp.connected"; server: string; tools: number }
  | { type: "mcp.failed"; server: string; error: string }
  | { type: "skill.loaded"; name: string }
  | { type: "skill.invoked"; name: string }
  | { type: "skill.installed"; name: string; source: string };

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

