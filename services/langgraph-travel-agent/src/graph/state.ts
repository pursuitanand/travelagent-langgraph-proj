import { Annotation } from "@langchain/langgraph";
import type {
  ChatTurn,
  FlightOffer,
  TravelBrief,
  TravelIntent,
  WebSearchResult,
} from "../domain/types.js";
import type { UserProfile } from "../memory/profile.js";
import type { FlightRepository } from "../repositories/FlightRepository.js";
import type { ResponseGenerator } from "../services/ResponseGenerator.js";
import type { WebSearchService } from "../services/WebSearchService.js";
import type { Logger } from "../util/logger.js";

/** Collaborators the nodes need, injected once when the graph is built. */
export interface AgentDependencies {
  flights: FlightRepository;
  web: WebSearchService;
  responder: ResponseGenerator;
  logger: Logger;
  /** Injectable clock so date parsing ("next friday") is testable. */
  now: () => Date;
  /** Conversation turns (user + assistant pairs) kept in short-term memory. Default 10. */
  memoryWindowTurns?: number;
}

/**
 * Keys a caller puts in `config.configurable` when invoking the graph.
 * `thread_id` selects the short-term memory (checkpoint thread);
 * `user_id` selects the long-term memory namespace in the store.
 */
export interface TravelRunConfigurable {
  thread_id: string;
  user_id?: string;
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Update for a list channel: a plain array appends, `{ replace }` overwrites.
 *
 * Appending is what lets the parallel branches both write `notes`/`errors`
 * without clobbering each other. Replacing is needed because the checkpointer
 * restores every channel at the start of a new turn: `loadMemory` uses it to
 * clear the turn-scoped lists, and `saveMemory` to trim the message window.
 */
export type ListUpdate<T> = T[] | { replace: T[] };

const appendOrReplace = <T>() =>
  Annotation<T[], ListUpdate<T>>({
    reducer: (current, incoming) =>
      Array.isArray(incoming) ? [...current, ...incoming] : incoming.replace,
    default: () => [],
  });

/** Plain overwrite: the channel has exactly one writer per turn. */
const lastValue = <T>(fallback: () => T) =>
  Annotation<T>({
    reducer: (_current, incoming) => incoming,
    default: fallback,
  });

// ---------------------------------------------------------------------------
// Schema 1 - INPUT: the only keys a caller may send into the graph.
// ---------------------------------------------------------------------------

export const TravelInputAnnotation = Annotation.Root({
  /** The user's current message. */
  message: lastValue<string>(() => ""),
  /**
   * Client-held transcript. Only used to seed or repair short-term memory
   * (see `loadMemory`); the checkpointed `messages` channel is authoritative.
   */
  history: lastValue<ChatTurn[]>(() => []),
});

// ---------------------------------------------------------------------------
// Schema 2 - OUTPUT: the only keys `graph.invoke()` returns.
// ---------------------------------------------------------------------------

export const TravelOutputAnnotation = Annotation.Root({
  /** Set by generateResponse. */
  reply: lastValue<string>(() => ""),
  responder: lastValue<string>(() => ""),

  /** Set by parseRequest. */
  intent: lastValue<TravelIntent | null>(() => null),

  /** Set by flightSearch. */
  outboundOffers: lastValue<FlightOffer[]>(() => []),
  inboundOffers: lastValue<FlightOffer[]>(() => []),

  /** Set by webSearch. */
  webResults: lastValue<WebSearchResult[]>(() => []),

  /** Set by combineResults. */
  brief: lastValue<TravelBrief | null>(() => null),

  /** Long-term memory for this user, as loaded (and then updated) this turn. */
  profile: lastValue<UserProfile | null>(() => null),
  /** Where this turn's conversational context came from. */
  memorySource: lastValue<MemorySource>(() => "empty"),

  /** Turn-scoped diagnostics, written by several nodes. */
  notes: appendOrReplace<string>(),
  errors: appendOrReplace<string>(),
  trace: appendOrReplace<string>(),
});

export type MemorySource = "checkpoint" | "client-history" | "empty";

// ---------------------------------------------------------------------------
// Schema 3 - OVERALL: input + output + private working memory.
// ---------------------------------------------------------------------------

export const TravelStateAnnotation = Annotation.Root({
  ...TravelInputAnnotation.spec,
  ...TravelOutputAnnotation.spec,

  /**
   * Short-term memory: the rolling conversation window. Persisted per thread
   * by the checkpointer, appended by `saveMemory`, never returned to callers.
   */
  messages: appendOrReplace<ChatTurn>(),

  /** Structured memory of the previous turn, so follow-ups need no re-parsing. */
  lastIntent: lastValue<TravelIntent | null>(() => null),

  /** Raw answer box from the web search; folded into `brief`, not exposed. */
  webAnswer: lastValue<string | null>(() => null),
});

// ---------------------------------------------------------------------------
// Schema 4 - NODE-SCOPED INPUT: what the search branches are allowed to see.
// ---------------------------------------------------------------------------

/**
 * `flightSearch` and `webSearch` receive only the parsed intent - not the
 * transcript, the profile or each other's results. Narrow inputs keep the
 * branches independent and make it explicit what context each one consumes.
 */
export const SearchInputAnnotation = Annotation.Root({
  intent: TravelOutputAnnotation.spec.intent,
});

export type TravelInput = typeof TravelInputAnnotation.State;
export type TravelOutput = typeof TravelOutputAnnotation.State;
export type TravelState = typeof TravelStateAnnotation.State;
export type TravelStateUpdate = Partial<typeof TravelStateAnnotation.Update>;
export type SearchInput = typeof SearchInputAnnotation.State;
