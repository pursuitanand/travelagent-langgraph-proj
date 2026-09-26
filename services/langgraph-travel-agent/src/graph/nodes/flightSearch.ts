import type { FlightSearchQuery } from "../../domain/types.js";
import { DEFAULT_SEARCH_LIMIT } from "../../repositories/FlightRepository.js";
import { toErrorMessage } from "../../util/errors.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

/**
 * Queries the `FlightRepository` for the outbound leg and, when a return date
 * was given, the inbound leg. Runs in parallel with `webSearch`.
 *
 * A repository failure degrades this branch only - it is recorded in
 * `errors` and the agent still answers with whatever else it found.
 */
export function createFlightSearchNode(deps: AgentDependencies) {
  return async function flightSearch(state: TravelState): Promise<TravelStateUpdate> {
    const intent = state.intent;
    if (!intent?.searchable || !intent.origin || !intent.destination) {
      return {
        outboundOffers: [],
        inboundOffers: [],
        notes: ["Flight search skipped: the route is not complete yet."],
        trace: ["flightSearch:skipped"],
      };
    }

    const baseQuery: FlightSearchQuery = {
      origin: intent.origin.iata,
      destination: intent.destination.iata,
      passengers: intent.passengers,
      limit: DEFAULT_SEARCH_LIMIT,
      ...(intent.departureDate ? { departureDate: intent.departureDate } : {}),
      ...(intent.cabinClass ? { cabinClass: intent.cabinClass } : {}),
      ...(intent.maxPrice !== null ? { maxPrice: intent.maxPrice } : {}),
    };

    try {
      const outbound = await deps.flights.search(baseQuery);
      const notes: string[] = [];

      if (outbound.usedDateFlexibility) {
        notes.push(
          `No seats on ${intent.departureDate}; showing the closest dates (${outbound.matchedDates.join(", ")}).`,
        );
      }
      if (outbound.offers.length === 0 && intent.maxPrice !== null) {
        notes.push(`Nothing matched under USD ${intent.maxPrice}.`);
      }

      let inboundOffers: TravelStateUpdate["inboundOffers"] = [];
      if (intent.returnDate) {
        const inbound = await deps.flights.search({
          ...baseQuery,
          origin: intent.destination.iata,
          destination: intent.origin.iata,
          departureDate: intent.returnDate,
        });
        inboundOffers = inbound.offers;
        if (inbound.usedDateFlexibility) {
          notes.push(
            `Return legs shown for ${inbound.matchedDates.join(", ")} rather than ${intent.returnDate}.`,
          );
        }
      }

      deps.logger.debug("flight search completed", {
        outbound: outbound.offers.length,
        inbound: inboundOffers?.length ?? 0,
      });

      return {
        outboundOffers: outbound.offers,
        inboundOffers,
        notes,
        trace: ["flightSearch"],
      };
    } catch (error) {
      const message = toErrorMessage(error);
      deps.logger.error("flight search failed", { error: message });
      return {
        outboundOffers: [],
        inboundOffers: [],
        errors: [`flightSearch: ${message}`],
        trace: ["flightSearch:error"],
      };
    }
  };
}
