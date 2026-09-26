import type { TravelIntent } from "../../domain/types.js";
import { toErrorMessage } from "../../util/errors.js";
import type { AgentDependencies, TravelState, TravelStateUpdate } from "../state.js";

/** Turns the parsed intent into one good Serper query. */
export function buildSearchQuery(intent: TravelIntent): string {
  const destination = intent.destination
    ? `${intent.destination.city}, ${intent.destination.country}`
    : null;

  if (!destination) {
    // Nothing to research about a place yet - fall back to the raw question.
    return intent.rawMessage.slice(0, 180);
  }

  const topics = intent.topics.length > 0 ? intent.topics : ["travel guide", "things to do"];
  const when = intent.departureDate ? ` ${monthYearOf(intent.departureDate)}` : "";
  return `${destination} ${topics.join(" ")}${when}`.replace(/\s+/g, " ").trim();
}

function monthYearOf(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Enriches the answer with live web context via Serper. Runs in parallel with
 * `flightSearch` and is always optional: no API key, a timeout or a provider
 * error degrades this branch only.
 */
export function createWebSearchNode(deps: AgentDependencies) {
  return async function webSearch(state: TravelState): Promise<TravelStateUpdate> {
    const intent = state.intent;
    if (!intent) {
      return { webResults: [], webAnswer: null, trace: ["webSearch:skipped"] };
    }

    if (!deps.web.enabled) {
      return {
        webResults: [],
        webAnswer: null,
        notes: ["Web search is disabled (no SERPER_API_KEY configured)."],
        trace: ["webSearch:disabled"],
      };
    }

    const query = buildSearchQuery(intent);

    try {
      const response = await deps.web.search(query);
      deps.logger.debug("web search completed", {
        query,
        resultCount: response.results.length,
      });
      return {
        webResults: response.results,
        webAnswer: response.answerBox ?? null,
        trace: ["webSearch"],
      };
    } catch (error) {
      const message = toErrorMessage(error);
      deps.logger.warn("web search failed", { error: message });
      return {
        webResults: [],
        webAnswer: null,
        errors: [`webSearch: ${message}`],
        notes: ["Live web results were unavailable for this answer."],
        trace: ["webSearch:error"],
      };
    }
  };
}
