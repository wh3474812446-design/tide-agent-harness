import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types.js";

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  metadata: Record<string, unknown>;
}

export class SessionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  create(metadata: Record<string, unknown> = {}): Session {
    const now = new Date().toISOString();
    return { id: randomUUID(), createdAt: now, updatedAt: now, messages: [], metadata };
  }

  async load(id: string): Promise<Session> {
    return JSON.parse(await readFile(this.#path(id), "utf8")) as Session;
  }

  async save(session: Session): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    session.updatedAt = new Date().toISOString();
    const target = this.#path(session.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(session, null, 2), "utf8");
    await rename(temporary, target);
  }

  #path(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid session id.");
    return path.join(this.#directory, `${id}.json`);
  }
}

