import { parseTravelRequest } from "../../domain/intentParser.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

/**
 * Entry node: free text -> typed `TravelIntent`.
 *
 * When the new message alone is not searchable ("what about business class?")
 * the previous user turn is parsed first and used as the baseline, so
 * follow-ups keep the route.
 */
export function createParseRequestNode(deps: AgentDependencies) {
  return async function parseRequest(state: TravelState): Promise<TravelStateUpdate> {
    const now = deps.now();
    let intent = parseTravelRequest(state.message, { now });

    if (!intent.searchable) {
      const lastUserTurn = [...state.history].reverse().find((turn) => turn.role === "user");
      if (lastUserTurn) {
        const previous = parseTravelRequest(lastUserTurn.content, { now });
        intent = parseTravelRequest(state.message, { now, previous });
      }
    }

    deps.logger.debug("parsed travel intent", {
      origin: intent.origin?.iata ?? null,
      destination: intent.destination?.iata ?? null,
      departureDate: intent.departureDate,
      searchable: intent.searchable,
    });

    const notes: string[] = [];
    if (!intent.origin && !intent.destination) {
      notes.push("No cities recognised in the request.");
    } else if (!intent.origin) {
      notes.push("Departure city is still missing.");
    } else if (!intent.destination) {
      notes.push("Destination city is still missing.");
    }

    return { intent, notes, trace: ["parseRequest"] };
  };
}
