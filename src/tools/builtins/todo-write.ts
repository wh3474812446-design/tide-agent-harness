import type { EventBus } from "../../events.js";
import type { Tool } from "../tool.js";

/**
 * 会话任务清单工具（移植自 Claude Code 的 TodoWriteTool）。
 * 让模型把多步任务显式外化成清单：开始前标 in_progress、做完立刻标 completed，
 * 同一时刻只有一个 in_progress。这是长链条里「不跑偏、不漏步、做完自检」的关键脚手架——
 * 清单写进上下文后，模型每轮都能看到剩余步骤，配合返回里的提醒持续推进。
 */

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  /** 祈使形，描述要做什么，如「运行测试」。 */
  content: string;
  /** 进行时形，执行中展示用，如「正在运行测试」。 */
  activeForm?: string;
  status: TodoStatus;
}

interface TodoInput {
  todos: TodoItem[];
}

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

const DESCRIPTION = `Create and manage a structured task list for the current session to track progress on multi-step work.

When to use: tasks with 3+ distinct steps, non-trivial work needing planning, when the user gives multiple tasks, or right after receiving new instructions (capture them as todos immediately). Skip it for a single trivial task.

Rules:
- Mark a task in_progress BEFORE starting it; keep exactly ONE task in_progress at a time.
- Mark a task completed IMMEDIATELY after finishing it — do not batch completions.
- Only mark completed when fully done; if blocked or partial, keep it in_progress and add a new task describing what's needed.
- Before reporting the whole job done, ensure a verification step (run tests / build / check output) exists and is completed.
- Pass the FULL updated list every call (it replaces the previous list).`;

export function createTodoWriteTool(deps: { events?: EventBus }): Tool {
  let latest: TodoItem[] = [];

  return {
    name: "todo_write",
    description: DESCRIPTION,
    risk: "read",
    concurrencySafe: false,
    source: "builtin",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full updated todo list (replaces the previous one).",
          items: {
            type: "object",
            properties: {
              content: { type: "string", minLength: 1, description: "Imperative form, e.g. 'Run tests'." },
              activeForm: { type: "string", description: "Present-continuous form, e.g. 'Running tests'." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(input) {
      const { todos } = input as TodoInput;
      latest = todos;
      deps.events?.emit({
        type: "todos.updated",
        todos: todos.map((t) => ({ content: t.content, status: t.status })),
      });

      const inProgress = todos.filter((t) => t.status === "in_progress").length;
      const checklist = todos.map((t) => `${STATUS_ICON[t.status]} ${t.content}`).join("\n");

      let reminder =
        "Todos updated. Keep using the list: mark the next task in_progress before starting it, " +
        "and mark each task completed the moment it's done. Proceed with the current task.";
      if (inProgress > 1) {
        reminder += `\n\nWARNING: ${inProgress} tasks are in_progress. Keep exactly ONE in_progress at a time.`;
      }
      const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
      const hasVerify = todos.some((t) => /verif|test|build|检查|验证|测试|构建/i.test(t.content));
      if (allDone && todos.length >= 3 && !hasVerify) {
        reminder +=
          "\n\nNOTE: You closed out 3+ tasks with no explicit verification step. Before reporting the job done, " +
          "actually verify it works (run tests / build / check output) and say so — or state clearly that you could not verify.";
      }

      return `${checklist}\n\n${reminder}`;
    },
  };
}

export type { TodoItem };
