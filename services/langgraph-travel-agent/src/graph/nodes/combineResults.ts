import { parseTravelRequest } from "../../domain/intentParser.js";
import type { FlightOffer, TravelBrief } from "../../domain/types.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

function cheapest(offers: FlightOffer[]): FlightOffer | null {
  return offers.reduce<FlightOffer | null>(
    (best, offer) =>
      best === null || Number(offer.totalAmount) < Number(best.totalAmount) ? offer : best,
    null,
  );
}

function fastest(offers: FlightOffer[]): FlightOffer | null {
  return offers.reduce<FlightOffer | null>((best, offer) => {
    const duration = offer.slices[0]?.durationMinutes ?? Number.POSITIVE_INFINITY;
    const bestDuration = best?.slices[0]?.durationMinutes ?? Number.POSITIVE_INFINITY;
    return duration < bestDuration ? offer : best;
  }, null);
}

/**
 * Join point for the two parallel branches.
 *
 * LangGraph runs this node once, after both `flightSearch` and `webSearch`
 * have completed, because both have an edge into it.
 */
export function createCombineResultsNode(deps: AgentDependencies) {
  return async function combineResults(state: TravelState): Promise<TravelStateUpdate> {
    const intent = state.intent ?? parseTravelRequest(state.message, { now: deps.now() });

    const outbound = state.outboundOffers;
    const amounts = outbound.map((offer) => Number(offer.totalAmount));
    const currency = outbound[0]?.totalCurrency ?? "USD";

    const brief: TravelBrief = {
      intent,
      outbound,
      inbound: state.inboundOffers,
      cheapestOutbound: cheapest(outbound),
      fastestOutbound: fastest(outbound),
      priceRange:
        amounts.length > 0
          ? {
              min: Math.round(Math.min(...amounts) * 100) / 100,
              max: Math.round(Math.max(...amounts) * 100) / 100,
              currency,
            }
          : null,
      webResults: state.webResults,
      webAnswer: state.webAnswer,
      // `notes` accumulated from both branches via the append reducer.
      notes: [...new Set(state.notes)],
    };

    deps.logger.debug("combined agent results", {
      outbound: brief.outbound.length,
      inbound: brief.inbound.length,
      webResults: brief.webResults.length,
      errors: state.errors.length,
    });

    return { brief, trace: ["combineResults"] };
  };
}
