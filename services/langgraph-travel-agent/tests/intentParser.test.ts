import { describe, expect, it } from "vitest";
import { parseTravelRequest } from "../src/domain/intentParser.js";

const NOW = new Date("2026-09-25T10:00:00Z"); // a Friday

describe("parseTravelRequest", () => {
  it("extracts route, date, passengers and cabin from a full request", () => {
    const intent = parseTravelRequest(
      "Find me a flight from London to Tokyo on 20 October for 2 people in business class",
      { now: NOW },
    );

    expect(intent.origin?.iata).toBe("LHR");
    expect(intent.destination?.iata).toBe("NRT");
    expect(intent.departureDate).toBe("2026-10-20");
    expect(intent.passengers).toBe(2);
    expect(intent.cabinClass).toBe("business");
    expect(intent.searchable).toBe(true);
  });

  it("understands bare IATA codes and ISO dates", () => {
    const intent = parseTravelRequest("LHR to JFK 2026-11-03, 3 passengers", { now: NOW });

    expect(intent.origin?.iata).toBe("LHR");
    expect(intent.destination?.iata).toBe("JFK");
    expect(intent.departureDate).toBe("2026-11-03");
    expect(intent.passengers).toBe(3);
  });

  it("rolls a month/day that has already passed into next year", () => {
    const intent = parseTravelRequest("Paris to Berlin on 12 May", { now: NOW });
    expect(intent.departureDate).toBe("2027-05-12");
  });

  it("resolves relative dates against the injected clock", () => {
    expect(parseTravelRequest("LHR to CDG tomorrow", { now: NOW }).departureDate).toBe(
      "2026-09-26",
    );
    expect(parseTravelRequest("LHR to CDG in 2 weeks", { now: NOW }).departureDate).toBe(
      "2026-10-09",
    );
    // NOW is a Friday, so "next friday" is a week out, not today.
    expect(parseTravelRequest("LHR to CDG next friday", { now: NOW }).departureDate).toBe(
      "2026-10-02",
    );
  });

  it("derives a return date from a trip length", () => {
    const intent = parseTravelRequest(
      "I want to visit Barcelona from Amsterdam, leaving 3rd November for a week",
      { now: NOW },
    );
    expect(intent.origin?.iata).toBe("AMS");
    expect(intent.destination?.iata).toBe("BCN");
    expect(intent.departureDate).toBe("2026-11-03");
    expect(intent.returnDate).toBe("2026-11-10");
  });

  it("reads an explicit return date and ignores it for one-way requests", () => {
    const roundTrip = parseTravelRequest("Mumbai to Dubai 5 Oct returning 12 Oct", {
      now: NOW,
    });
    expect(roundTrip.returnDate).toBe("2026-10-12");

    const oneWay = parseTravelRequest("one way LHR to BCN on 10 Oct", { now: NOW });
    expect(oneWay.returnDate).toBeNull();
  });

  it("captures a price ceiling", () => {
    expect(parseTravelRequest("LHR to JFK under $500", { now: NOW }).maxPrice).toBe(500);
    expect(
      parseTravelRequest("LHR to JFK with a budget of 750 usd", { now: NOW }).maxPrice,
    ).toBe(750);
  });

  it("only picks up topics that are genuinely mentioned", () => {
    const withTopics = parseTravelRequest(
      "Paris to Berlin in 2 weeks, need visa info and things to do",
      { now: NOW },
    );
    expect(withTopics.topics).toEqual(["visa requirements", "things to do"]);

    // "weather" must not also match the "eat" inside it.
    const weatherOnly = parseTravelRequest("Dubai to Singapore - what is the weather like?", {
      now: NOW,
    });
    expect(weatherOnly.topics).toEqual(["weather"]);
  });

  it("marks incomplete routes as not searchable", () => {
    const intent = parseTravelRequest("I fancy a holiday somewhere warm", { now: NOW });
    expect(intent.searchable).toBe(false);
    expect(intent.origin).toBeNull();
    expect(intent.destination).toBeNull();
  });

  it("inherits the route from a previous intent on a follow-up", () => {
    const previous = parseTravelRequest("London to Tokyo on 20 October", { now: NOW });
    const followUp = parseTravelRequest("what about first class?", { now: NOW, previous });

    expect(followUp.origin?.iata).toBe("LHR");
    expect(followUp.destination?.iata).toBe("NRT");
    expect(followUp.departureDate).toBe("2026-10-20");
    expect(followUp.cabinClass).toBe("first");
    expect(followUp.searchable).toBe(true);
  });

  it("never returns the same airport for both ends", () => {
    const intent = parseTravelRequest("flights from London to London", { now: NOW });
    expect(intent.destination).toBeNull();
    expect(intent.searchable).toBe(false);
  });
});
