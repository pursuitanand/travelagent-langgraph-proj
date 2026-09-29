import { parseTravelRequest } from "../../domain/intentParser.js";
import type { TravelIntent } from "../../domain/types.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

/**
 * Entry node: free text -> typed `TravelIntent`.
 *
 * Context is layered, most specific first:
 * 1. the current message;
 * 2. short-term memory - when the message alone is not searchable
 *    ("what about business class?"), the previous turn's intent is the
 *    baseline. It comes from the checkpointed `lastIntent`, or, when memory
 *    was re-seeded from the client, from re-parsing the last user turn;
 * 3. long-term memory - a missing departure city defaults to the traveller's
 *    home airport from their profile, and the reply says so.
 */
export function createParseRequestNode(deps: AgentDependencies) {
  return async function parseRequest(state: TravelState): Promise<TravelStateUpdate> {
    const now = deps.now();
    let intent = parseTravelRequest(state.message, { now });

    if (!intent.searchable) {
      const previous = state.lastIntent ?? previousIntentFromMessages(state, now);
      if (previous) {
        intent = parseTravelRequest(state.message, { now, previous });
      }
    }

    const notes: string[] = [];
    const home = state.profile?.homeAirport ?? null;
    if (!intent.origin && intent.destination && home && home.iata !== intent.destination.iata) {
      intent = { ...intent, origin: home, searchable: true };
      notes.push(`Assumed departure from your usual airport, ${home.city} (${home.iata}).`);
    }

    deps.logger.debug("parsed travel intent", {
      origin: intent.origin?.iata ?? null,
      destination: intent.destination?.iata ?? null,
      departureDate: intent.departureDate,
      searchable: intent.searchable,
    });

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

function previousIntentFromMessages(state: TravelState, now: Date): TravelIntent | null {
  const lastUserTurn = [...state.messages].reverse().find((turn) => turn.role === "user");
  return lastUserTurn ? parseTravelRequest(lastUserTurn.content, { now }) : null;
}
