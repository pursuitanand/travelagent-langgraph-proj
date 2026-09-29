import { describe, expect, it } from "vitest";
import { createTravelGraph, runTravelAgent } from "../src/graph/buildGraph.js";
import { buildSearchQuery } from "../src/graph/nodes/webSearch.js";
import type { AgentDependencies } from "../src/graph/state.js";
import { parseTravelRequest } from "../src/domain/intentParser.js";
import { TemplateResponseGenerator } from "../src/services/ResponseGenerator.js";
import { DisabledWebSearchService } from "../src/services/WebSearchService.js";
import { silentLogger } from "../src/util/logger.js";
import { FakeFlightRepository, FakeWebSearchService, makeOffer } from "./helpers/fakes.js";

const NOW = new Date("2026-09-25T10:00:00Z");

function deps(overrides: Partial<AgentDependencies> = {}): AgentDependencies {
  return {
    flights: new FakeFlightRepository({ offers: [makeOffer()] }),
    web: new FakeWebSearchService(),
    responder: new TemplateResponseGenerator(),
    logger: silentLogger,
    now: () => NOW,
    ...overrides,
  };
}

describe("travel agent graph", () => {
  it("runs every node in order and produces a reply", async () => {
    const graph = createTravelGraph(deps());

    const state = await runTravelAgent(graph, {
      message: "Find me a flight from London to Tokyo on 20 October for 2 people",
    });

    expect(state.trace).toEqual([
      "loadMemory",
      "parseRequest",
      "flightSearch",
      "webSearch",
      "combineResults",
      "generateResponse",
      "saveMemory",
    ]);
    expect(state.intent?.origin?.iata).toBe("LHR");
    expect(state.intent?.destination?.iata).toBe("NRT");
    expect(state.outboundOffers).toHaveLength(1);
    expect(state.webResults).toHaveLength(1);
    expect(state.brief?.cheapestOutbound?.id).toBe("off_FAKE0001");
    expect(state.reply).toContain("British Airways");
    expect(state.responder).toBe("template");
    expect(state.errors).toEqual([]);
  });

  it("passes the parsed filters through to the repository", async () => {
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }));

    await runTravelAgent(graph, {
      message: "LHR to NRT on 20 October, 2 adults, business class under $3000",
    });

    expect(flights.queries[0]).toMatchObject({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
      passengers: 2,
      cabinClass: "business",
      maxPrice: 3000,
    });
  });

  it("searches the reverse route when a return date is given", async () => {
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }));

    await runTravelAgent(graph, {
      message: "London to Tokyo on 20 October returning 27 October",
    });

    expect(flights.queries).toHaveLength(2);
    expect(flights.queries[1]).toMatchObject({
      origin: "NRT",
      destination: "LHR",
      departureDate: "2026-10-27",
    });
  });

  it("skips the flight search when the route is incomplete", async () => {
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }));

    const state = await runTravelAgent(graph, { message: "I want to go somewhere sunny" });

    expect(flights.queries).toHaveLength(0);
    expect(state.trace).toContain("flightSearch:skipped");
    expect(state.reply).toContain("once I know both ends of the trip");
  });

  it("keeps answering when the flight repository fails", async () => {
    const flights = new FakeFlightRepository({ failWith: new Error("db offline") });
    const graph = createTravelGraph(deps({ flights }));

    const state = await runTravelAgent(graph, { message: "London to Tokyo on 20 October" });

    expect(state.errors).toEqual(["flightSearch: db offline"]);
    expect(state.trace).toContain("flightSearch:error");
    // The web branch still contributed, and a reply was still produced.
    expect(state.webResults).toHaveLength(1);
    expect(state.reply).not.toBe("");
  });

  it("keeps answering when web search fails", async () => {
    const web = new FakeWebSearchService({ failWith: new Error("serper 500") });
    const graph = createTravelGraph(deps({ web }));

    const state = await runTravelAgent(graph, { message: "London to Tokyo on 20 October" });

    expect(state.errors).toEqual(["webSearch: serper 500"]);
    expect(state.outboundOffers).toHaveLength(1);
    expect(state.reply).toContain("British Airways");
  });

  it("notes that web search is off when no provider is configured", async () => {
    const graph = createTravelGraph(deps({ web: new DisabledWebSearchService() }));

    const state = await runTravelAgent(graph, { message: "London to Tokyo on 20 October" });

    expect(state.trace).toContain("webSearch:disabled");
    expect(state.brief?.notes).toContain(
      "Web search is disabled (no SERPER_API_KEY configured).",
    );
  });

  it("carries the route forward across conversation turns", async () => {
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }));

    const state = await runTravelAgent(graph, {
      message: "what about business class?",
      history: [
        { role: "user", content: "London to Tokyo on 20 October" },
        { role: "assistant", content: "Here are some options..." },
      ],
    });

    expect(state.intent?.origin?.iata).toBe("LHR");
    expect(state.intent?.destination?.iata).toBe("NRT");
    expect(flights.queries[0]).toMatchObject({ cabinClass: "business" });
  });

  it("surfaces the cheapest and fastest offers separately", async () => {
    const flights = new FakeFlightRepository({
      offers: [
        makeOffer({ id: "off_SLOW_CHEAP", totalAmount: "300.00" }),
        makeOffer({
          id: "off_FAST_PRICEY",
          totalAmount: "900.00",
          slices: [
            {
              ...makeOffer().slices[0]!,
              id: "sli_FAST",
              durationMinutes: 600,
            },
          ],
        }),
      ],
    });
    const graph = createTravelGraph(deps({ flights }));

    const state = await runTravelAgent(graph, { message: "London to Tokyo on 20 October" });

    expect(state.brief?.cheapestOutbound?.id).toBe("off_SLOW_CHEAP");
    expect(state.brief?.fastestOutbound?.id).toBe("off_FAST_PRICEY");
    expect(state.brief?.priceRange).toEqual({ min: 300, max: 900, currency: "USD" });
  });
});

describe("buildSearchQuery", () => {
  it("builds a destination-focused query from the parsed topics", () => {
    const intent = parseTravelRequest("London to Tokyo on 20 October, visa and food tips", {
      now: NOW,
    });
    const query = buildSearchQuery(intent);

    expect(query).toContain("Tokyo, Japan");
    expect(query).toContain("visa requirements");
    expect(query).toContain("October 2026");
  });

  it("falls back to generic travel topics when none were mentioned", () => {
    const intent = parseTravelRequest("London to Tokyo", { now: NOW });
    expect(buildSearchQuery(intent)).toContain("things to do");
  });

  it("falls back to the raw message when there is no destination", () => {
    const intent = parseTravelRequest("is my passport still valid?", { now: NOW });
    expect(buildSearchQuery(intent)).toBe("is my passport still valid?");
  });
});
