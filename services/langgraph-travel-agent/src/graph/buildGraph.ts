import { randomUUID } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { ChatTurn } from "../domain/types.js";
import { createAgentMemory, type AgentMemory } from "../memory/index.js";
import { createCombineResultsNode } from "./nodes/combineResults.js";
import { createFlightSearchNode } from "./nodes/flightSearch.js";
import { createGenerateResponseNode } from "./nodes/generateResponse.js";
import { createLoadMemoryNode } from "./nodes/loadMemory.js";
import { createParseRequestNode } from "./nodes/parseRequest.js";
import { createSaveMemoryNode } from "./nodes/saveMemory.js";
import { createWebSearchNode } from "./nodes/webSearch.js";
import {
  SearchInputAnnotation,
  TravelInputAnnotation,
  TravelOutputAnnotation,
  TravelStateAnnotation,
  type AgentDependencies,
  type TravelOutput,
  type TravelRunConfigurable,
} from "./state.js";

/**
 * Wires the travel agent:
 *
 *                                    +--> flightSearch --+
 *   START -> loadMemory -> parseRequest                  +--> combineResults
 *                                    +--> webSearch -----+          |
 *                                                                   v
 *                                END <- saveMemory <- generateResponse
 *
 * `flightSearch` and `webSearch` have no edge between them, so LangGraph runs
 * them concurrently in one superstep; `combineResults` has an incoming edge
 * from each, so it runs exactly once, after both have finished.
 *
 * The graph uses three schemas - input, output and the overall state - and
 * the search branches get a fourth, narrower node-level input. It is compiled
 * with a checkpointer (short-term memory per `thread_id`) and a store
 * (long-term memory per `user_id`).
 */
export function createTravelGraph(
  deps: AgentDependencies,
  memory: Pick<AgentMemory, "checkpointer" | "store"> = createAgentMemory(),
) {
  const graph = new StateGraph({
    stateSchema: TravelStateAnnotation,
    input: TravelInputAnnotation,
    output: TravelOutputAnnotation,
  })
    .addNode("loadMemory", createLoadMemoryNode(deps))
    .addNode("parseRequest", createParseRequestNode(deps))
    .addNode("flightSearch", createFlightSearchNode(deps), { input: SearchInputAnnotation })
    .addNode("webSearch", createWebSearchNode(deps), { input: SearchInputAnnotation })
    .addNode("combineResults", createCombineResultsNode(deps))
    .addNode("generateResponse", createGenerateResponseNode(deps))
    .addNode("saveMemory", createSaveMemoryNode(deps))
    .addEdge(START, "loadMemory")
    .addEdge("loadMemory", "parseRequest")
    .addEdge("parseRequest", "flightSearch")
    .addEdge("parseRequest", "webSearch")
    .addEdge("flightSearch", "combineResults")
    .addEdge("webSearch", "combineResults")
    .addEdge("combineResults", "generateResponse")
    .addEdge("generateResponse", "saveMemory")
    .addEdge("saveMemory", END);

  return graph.compile({ checkpointer: memory.checkpointer, store: memory.store });
}

export type TravelGraph = ReturnType<typeof createTravelGraph>;

export interface RunAgentInput {
  message: string;
  /** Client-held transcript; only used to seed or repair server memory. */
  history?: ChatTurn[];
  /** Session / LangGraph thread. A fresh one is used when omitted. */
  threadId?: string;
  /** Enables long-term memory for this user. */
  userId?: string;
}

/** Convenience wrapper so the HTTP layer never touches LangGraph directly. */
export async function runTravelAgent(
  graph: TravelGraph,
  input: RunAgentInput,
): Promise<TravelOutput> {
  const configurable: TravelRunConfigurable = {
    thread_id: input.threadId ?? randomUUID(),
    ...(input.userId ? { user_id: input.userId } : {}),
  };
  return (await graph.invoke(
    { message: input.message, history: input.history ?? [] },
    { configurable },
  )) as TravelOutput;
}
