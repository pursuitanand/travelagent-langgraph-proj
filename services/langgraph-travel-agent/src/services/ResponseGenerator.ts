import type { ChatTurn, FlightOffer, TravelBrief } from "../domain/types.js";
import {
  daysBetweenIsoDates,
  formatDuration,
  isoDateOf,
  isoTimeOf,
} from "../util/time.js";

export interface GenerateInput {
  brief: TravelBrief;
  history: ChatTurn[];
}

export interface GenerateOutput {
  text: string;
  /** Which generator actually produced the text (useful for diagnostics). */
  generator: string;
  model?: string;
}

/** Turns the combined flight + web brief into the assistant's reply. */
export interface ResponseGenerator {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

// ---------------------------------------------------------------------------
// Shared formatting helpers - used by the prompt builder and the template
// responder so both describe offers the same way.
// ---------------------------------------------------------------------------

export function describeOffer(offer: FlightOffer): string {
  const slice = offer.slices[0];
  if (!slice) return `${offer.owner.name} - ${offer.totalCurrency} ${offer.totalAmount}`;

  const stops = slice.segments.length - 1;
  const stopLabel =
    stops === 0 ? "non-stop" : stops === 1 ? `1 stop (${slice.segments[0]?.destination})` : `${stops} stops`;
  const flightNumbers = slice.segments.map((s) => s.flightNumber).join(" + ");

  // Long-haul flights routinely land on the following local day.
  const dayRollover = daysBetweenIsoDates(
    isoDateOf(slice.departingAt),
    isoDateOf(slice.arrivingAt),
  );
  const arrivalSuffix = dayRollover > 0 ? ` (+${dayRollover}d)` : "";

  return [
    `${offer.owner.name} ${flightNumbers}`,
    `${isoDateOf(slice.departingAt)} ${slice.origin} ${isoTimeOf(slice.departingAt)} -> ${slice.destination} ${isoTimeOf(slice.arrivingAt)}${arrivalSuffix}`,
    formatDuration(slice.durationMinutes),
    stopLabel,
    offer.cabinClass.replace("_", " "),
    `${offer.totalCurrency} ${offer.totalAmount}`,
    offer.baggageIncluded > 0 ? `${offer.baggageIncluded} bag included` : "no checked bag",
    offer.refundable ? "refundable" : "non-refundable",
  ].join(" | ");
}

/** Compact, LLM-friendly rendering of everything the agent gathered. */
export function renderBrief(brief: TravelBrief): string {
  const { intent } = brief;
  const lines: string[] = [];

  lines.push("## Traveller request");
  lines.push(`- Raw message: ${intent.rawMessage}`);
  lines.push(`- Origin: ${intent.origin ? `${intent.origin.city} (${intent.origin.iata})` : "unknown"}`);
  lines.push(
    `- Destination: ${intent.destination ? `${intent.destination.city} (${intent.destination.iata})` : "unknown"}`,
  );
  lines.push(`- Departure date: ${intent.departureDate ?? "unspecified"}`);
  lines.push(`- Return date: ${intent.returnDate ?? "none (one way)"}`);
  lines.push(`- Passengers: ${intent.passengers}`);
  lines.push(`- Cabin: ${intent.cabinClass ?? "any"}`);
  lines.push(`- Budget cap: ${intent.maxPrice !== null ? `USD ${intent.maxPrice}` : "none stated"}`);

  lines.push("", "## Outbound offers (from inventory)");
  lines.push(
    brief.outbound.length > 0
      ? brief.outbound.map((offer, i) => `${i + 1}. ${describeOffer(offer)}`).join("\n")
      : "- none found",
  );

  if (brief.inbound.length > 0) {
    lines.push("", "## Return offers (from inventory)");
    lines.push(brief.inbound.map((offer, i) => `${i + 1}. ${describeOffer(offer)}`).join("\n"));
  }

  if (brief.priceRange) {
    lines.push(
      "",
      `Outbound price range: ${brief.priceRange.currency} ${brief.priceRange.min} - ${brief.priceRange.max}`,
    );
  }

  if (brief.webAnswer || brief.webResults.length > 0) {
    lines.push("", "## Web research");
    if (brief.webAnswer) lines.push(`Summary box: ${brief.webAnswer}`);
    for (const result of brief.webResults) {
      lines.push(`- [${result.title}](${result.link}) - ${result.snippet}`);
    }
  }

  if (brief.notes.length > 0) {
    lines.push("", "## Pipeline notes");
    for (const note of brief.notes) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Produces a useful answer with no LLM call at all.
 *
 * It is the default when ANTHROPIC_API_KEY is unset, the safety net when the
 * API call fails, and what the tests assert against (being deterministic).
 */
export class TemplateResponseGenerator implements ResponseGenerator {
  readonly name = "template";

  async generate({ brief }: GenerateInput): Promise<GenerateOutput> {
    return { text: this.render(brief), generator: this.name };
  }

  private render(brief: TravelBrief): string {
    const { intent } = brief;
    const out: string[] = [];

    if (!intent.origin || !intent.destination) {
      out.push(
        "I can search flights once I know both ends of the trip.",
        "",
        "Tell me something like **\"London to Tokyo on 12 May for 2 people in business\"** and I'll pull up options.",
      );
      if (brief.webResults.length > 0) {
        out.push("", "In the meantime, here is what the web says:");
        out.push(...brief.webResults.slice(0, 3).map((r) => `- [${r.title}](${r.link})`));
      }
      return out.join("\n");
    }

    const route = `${intent.origin.city} (${intent.origin.iata}) to ${intent.destination.city} (${intent.destination.iata})`;
    out.push(`### ${route}`);

    if (brief.outbound.length === 0) {
      out.push("", `I could not find any inventory for ${route}${dateSuffix(intent.departureDate)}.`);
      out.push("Try a nearby date, or a different pair of cities.");
    } else {
      // Say "around" rather than "on" when the repository widened the date.
      const exactDateOnly =
        intent.departureDate !== null &&
        brief.outbound.every(
          (offer) => isoDateOf(offer.slices[0]?.departingAt ?? "") === intent.departureDate,
        );
      const when = intent.departureDate
        ? `${exactDateOnly ? " on" : " around"} ${intent.departureDate}`
        : "";

      out.push(
        "",
        `Found **${brief.outbound.length}** outbound option${brief.outbound.length === 1 ? "" : "s"}${when} for ${intent.passengers} passenger${intent.passengers === 1 ? "" : "s"}:`,
        "",
      );
      out.push(...brief.outbound.map((offer) => `- ${describeOffer(offer)}`));

      if (brief.cheapestOutbound) {
        out.push(
          "",
          `**Cheapest:** ${brief.cheapestOutbound.owner.name} at ${brief.cheapestOutbound.totalCurrency} ${brief.cheapestOutbound.totalAmount}.`,
        );
      }
      if (brief.fastestOutbound && brief.fastestOutbound.id !== brief.cheapestOutbound?.id) {
        const minutes = brief.fastestOutbound.slices[0]?.durationMinutes ?? 0;
        out.push(
          `**Fastest:** ${brief.fastestOutbound.owner.name} in ${formatDuration(minutes)}.`,
        );
      }
    }

    if (brief.inbound.length > 0) {
      out.push("", `**Return legs** on ${intent.returnDate}:`, "");
      out.push(...brief.inbound.map((offer) => `- ${describeOffer(offer)}`));
    }

    if (brief.webAnswer) {
      out.push("", "### Good to know", brief.webAnswer);
    }
    if (brief.webResults.length > 0) {
      out.push("", "### Sources");
      out.push(...brief.webResults.map((r) => `- [${r.title}](${r.link})`));
    }
    if (brief.notes.length > 0) {
      out.push("", `_${brief.notes.join(" ")}_`);
    }

    return out.join("\n");
  }
}

function dateSuffix(date: string | null): string {
  return date ? ` on ${date}` : "";
}
