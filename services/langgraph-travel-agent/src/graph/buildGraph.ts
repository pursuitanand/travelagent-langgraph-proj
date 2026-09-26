import { END, START, StateGraph } from "@langchain/langgraph";
import type { ChatTurn } from "../domain/types.js";
import { createCombineResultsNode } from "./nodes/combineResults.js";
import { createFlightSearchNode } from "./nodes/flightSearch.js";
import { createGenerateResponseNode } from "./nodes/generateResponse.js";
import { createParseRequestNode } from "./nodes/parseRequest.js";
import { createWebSearchNode } from "./nodes/webSearch.js";
import { TravelStateAnnotation, type AgentDependencies, type TravelState } from "./state.js";

/**
 * Wires the travel agent:
 *
 *                     +--> flightSearch --+
 *   START -> parseRequest                 +--> combineResults -> generateResponse -> END
 *                     +--> webSearch -----+
 *
 * `flightSearch` and `webSearch` have no edge between them, so LangGraph runs
 * them concurrently in one superstep; `combineResults` has an incoming edge
 * from each, so it runs exactly once, after both have finished.
 */
export function createTravelGraph(deps: AgentDependencies) {
  const graph = new StateGraph(TravelStateAnnotation)
    .addNode("parseRequest", createParseRequestNode(deps))
    .addNode("flightSearch", createFlightSearchNode(deps))
    .addNode("webSearch", createWebSearchNode(deps))
    .addNode("combineResults", createCombineResultsNode(deps))
    .addNode("generateResponse", createGenerateResponseNode(deps))
    .addEdge(START, "parseRequest")
    .addEdge("parseRequest", "flightSearch")
    .addEdge("parseRequest", "webSearch")
    .addEdge("flightSearch", "combineResults")
    .addEdge("webSearch", "combineResults")
    .addEdge("combineResults", "generateResponse")
    .addEdge("generateResponse", END);

  return graph.compile();
}

export type TravelGraph = ReturnType<typeof createTravelGraph>;

export interface RunAgentInput {
  message: string;
  history?: ChatTurn[];
}

/** Convenience wrapper so the HTTP layer never touches LangGraph directly. */
export async function runTravelAgent(
  graph: TravelGraph,
  input: RunAgentInput,
): Promise<TravelState> {
  return (await graph.invoke({
    message: input.message,
    history: input.history ?? [],
  })) as TravelState;
}
