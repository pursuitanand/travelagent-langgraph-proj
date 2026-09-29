import {
  InMemoryStore,
  MemorySaver,
  type BaseCheckpointSaver,
  type BaseStore,
} from "@langchain/langgraph";
import { ProfileStore } from "./profile.js";
import { SessionRegistry } from "./sessions.js";

export { emptyProfile, learnFromIntent, ProfileStore, type UserProfile } from "./profile.js";
export { SessionRegistry, type SessionInfo } from "./sessions.js";

/**
 * The agent's two memory tiers, created together so the graph and the HTTP
 * layer always share the same instances.
 *
 * - `checkpointer` - short-term, thread-scoped memory (graph state per session)
 * - `store`        - long-term, cross-thread memory (per-user profile)
 */
export interface AgentMemory {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
  sessions: SessionRegistry;
  profiles: ProfileStore;
}

export interface AgentMemoryOptions {
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => Date;
  /** Swap in a durable saver/store (e.g. Postgres) without touching the graph. */
  checkpointer?: BaseCheckpointSaver;
  store?: BaseStore;
}

export function createAgentMemory(options: AgentMemoryOptions = {}): AgentMemory {
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const store = options.store ?? new InMemoryStore();
  return {
    checkpointer,
    store,
    sessions: new SessionRegistry({
      checkpointer,
      ttlMs: options.sessionTtlMs ?? 60 * 60_000,
      maxSessions: options.maxSessions ?? 1000,
      ...(options.now ? { now: options.now } : {}),
    }),
    profiles: new ProfileStore(store),
  };
}
