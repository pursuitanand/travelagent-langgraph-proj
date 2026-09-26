import { describe, expect, it } from "vitest";
import { buildFlightSearchSql } from "../src/repositories/postgresQuery.js";

describe("buildFlightSearchSql", () => {
  it("builds the minimal query with upper-cased route codes", () => {
    const { text, values } = buildFlightSearchSql({ origin: "lhr", destination: "jfk" });

    expect(text).toContain("FROM flight_offer_json");
    expect(text).toContain("origin = $1");
    expect(text).toContain("destination = $2");
    expect(text).toContain("seats_available >= $3");
    expect(text).toContain("ORDER BY total_amount ASC, departing_at ASC");
    // origin, destination, passengers, limit
    expect(values).toEqual(["LHR", "JFK", 1, 6]);
  });

  it("adds an inclusive date window when one is supplied", () => {
    const { text, values } = buildFlightSearchSql(
      { origin: "LHR", destination: "JFK", departureDate: "2026-10-20" },
      { from: "2026-10-18", to: "2026-10-22" },
    );

    expect(text).toContain("departing_on >= $4::date");
    expect(text).toContain("departing_on <= $5::date");
    expect(values[3]).toBe("2026-10-18");
    expect(values[4]).toBe("2026-10-22");
  });

  it("applies cabin, price, currency, passenger and limit filters", () => {
    const { text, values } = buildFlightSearchSql({
      origin: "LHR",
      destination: "JFK",
      passengers: 3,
      cabinClass: "business",
      maxPrice: 2500,
      currency: "usd",
      limit: 2,
    });

    expect(text).toContain("cabin_class = $4");
    expect(text).toContain("total_amount <= $5");
    expect(text).toContain("total_currency = $6");
    expect(values).toEqual(["LHR", "JFK", 3, "business", 2500, "USD", 2]);
  });

  it("parameterises every value rather than inlining it", () => {
    const { text } = buildFlightSearchSql({
      origin: "LHR'; DROP TABLE flight_offers; --",
      destination: "JFK",
    });

    expect(text).not.toContain("DROP TABLE");
    expect(text).toContain("origin = $1");
  });

  it("omits the date predicates when no window is given", () => {
    const { text } = buildFlightSearchSql({ origin: "LHR", destination: "JFK" });
    expect(text).not.toContain("departing_on");
  });
});
