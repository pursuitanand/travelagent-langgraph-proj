import type { BaseCheckpointSaver } from "@langchain/langgraph";

/** Bookkeeping for one conversation; the conversation itself lives in the checkpointer. */
export interface SessionInfo {
  /** Also the LangGraph `thread_id`. */
  id: string;
  userId: string | null;
  createdAt: string;
  lastActiveAt: string;
  /** Completed agent turns in this session. */
  turns: number;
}

export interface SessionRegistryOptions {
  checkpointer: BaseCheckpointSaver;
  /** Idle time after which a session and its checkpoints are dropped. */
  ttlMs: number;
  /** Hard cap; the least recently active session is evicted beyond it. */
  maxSessions: number;
  now?: () => Date;
}

/**
 * Maps a client `conversationId` to a LangGraph thread and enforces its
 * lifecycle.
 *
 * The checkpointer never forgets on its own, so without this an in-memory
 * deployment would grow without bound. Expiry and eviction delete the thread's
 * checkpoints, which is what actually frees the short-term memory.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly now: () => Date;

  constructor(private readonly options: SessionRegistryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return this.isExpired(session) ? null : { ...session };
  }

  /** Marks the start of a turn: creates the session if needed and refreshes its TTL. */
  async begin(id: string, userId: string | null): Promise<SessionInfo> {
    await this.sweep();

    const now = this.now().toISOString();
    const existing = this.sessions.get(id);
    const session: SessionInfo = existing
      ? { ...existing, userId: userId ?? existing.userId, lastActiveAt: now }
      : { id, userId, createdAt: now, lastActiveAt: now, turns: 0 };

    // Re-insert so Map iteration order stays least-recently-active first.
    this.sessions.delete(id);
    this.sessions.set(id, session);
    await this.enforceCapacity();
    return { ...session };
  }

  /** Marks a turn as completed. */
  complete(id: string): SessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.turns += 1;
    session.lastActiveAt = this.now().toISOString();
    return { ...session };
  }

  /** Forgets the session and deletes its checkpoints. Returns false when unknown. */
  async delete(id: string): Promise<boolean> {
    const known = this.sessions.delete(id);
    await this.options.checkpointer.deleteThread(id);
    return known;
  }

  /** Drops every idle session. Called on each `begin`, so no timer is needed. */
  async sweep(): Promise<number> {
    const expired = [...this.sessions.values()].filter((s) => this.isExpired(s));
    for (const session of expired) await this.delete(session.id);
    return expired.length;
  }

  private async enforceCapacity(): Promise<void> {
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) return;
      await this.delete(oldest);
    }
  }

  private isExpired(session: SessionInfo): boolean {
    return this.now().getTime() - Date.parse(session.lastActiveAt) > this.options.ttlMs;
  }
}
