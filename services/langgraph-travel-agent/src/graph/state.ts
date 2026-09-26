import { Annotation } from "@langchain/langgraph";
import type {
  ChatTurn,
  FlightOffer,
  TravelBrief,
  TravelIntent,
  WebSearchResult,
} from "../domain/types.js";
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
}

/** Appends, rather than replaces - used by the parallel branches. */
const appendStrings = {
  reducer: (current: string[], incoming: string[]) => [...current, ...incoming],
  default: (): string[] => [],
};

/**
 * Typed LangGraph state.
 *
 * `flightSearch` and `webSearch` run in the same superstep, so every channel
 * they both write to (`notes`, `errors`) uses an append reducer; every other
 * channel is written by exactly one node.
 */
export const TravelStateAnnotation = Annotation.Root({
  /** The user's current message. */
  message: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),

  /** Prior turns of this conversation, oldest first. */
  history: Annotation<ChatTurn[]>({
    reducer: (_current, incoming) => incoming,
    default: () => [],
  }),

  /** Set by parseRequest. */
  intent: Annotation<TravelIntent | null>({
    reducer: (_current, incoming) => incoming,
    default: () => null,
  }),

  /** Set by flightSearch. */
  outboundOffers: Annotation<FlightOffer[]>({
    reducer: (_current, incoming) => incoming,
    default: () => [],
  }),
  inboundOffers: Annotation<FlightOffer[]>({
    reducer: (_current, incoming) => incoming,
    default: () => [],
  }),

  /** Set by webSearch. */
  webResults: Annotation<WebSearchResult[]>({
    reducer: (_current, incoming) => incoming,
    default: () => [],
  }),
  webAnswer: Annotation<string | null>({
    reducer: (_current, incoming) => incoming,
    default: () => null,
  }),

  /** Set by combineResults. */
  brief: Annotation<TravelBrief | null>({
    reducer: (_current, incoming) => incoming,
    default: () => null,
  }),

  /** Set by generateResponse. */
  reply: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),
  responder: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),

  /** Written by several nodes - hence the append reducers. */
  notes: Annotation<string[]>(appendStrings),
  errors: Annotation<string[]>(appendStrings),
  trace: Annotation<string[]>(appendStrings),
});

export type TravelState = typeof TravelStateAnnotation.State;
export type TravelStateUpdate = Partial<typeof TravelStateAnnotation.Update>;
