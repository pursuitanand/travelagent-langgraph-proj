import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFlightRepository } from "../src/repositories/JsonFlightRepository.js";
import { isoDateOf } from "../src/util/time.js";

const FIXTURE = "tests/fixtures/flights.sample.json";

/** The fixture's dataset starts on 2030-01-01. */
function repoWithFixedDates(): JsonFlightRepository {
  return new JsonFlightRepository({ dataFile: FIXTURE, rollDates: false });
}

describe("JsonFlightRepository", () => {
  let repo: JsonFlightRepository;

  beforeEach(async () => {
    repo = repoWithFixedDates();
    await repo.init();
  });

  afterEach(async () => {
    await repo.close();
  });

  it("refuses to serve queries before init()", async () => {
    const fresh = new JsonFlightRepository({ dataFile: FIXTURE, rollDates: false });
    await expect(fresh.search({ origin: "LHR", destination: "JFK" })).rejects.toThrow(
      /init\(\) must be awaited/,
    );
  });

  it("reports health once loaded", async () => {
    const health = await repo.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("4 offers");
  });

  it("finds offers on the requested date, cheapest first", async () => {
    const result = await repo.search({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2030-01-01",
    });

    expect(result.usedDateFlexibility).toBe(false);
    expect(result.offers.map((o) => o.id)).toEqual(["off_TEST0002", "off_TEST0001"]);
    expect(result.matchedDates).toEqual(["2030-01-01"]);
  });

  it("is case-insensitive about IATA codes", async () => {
    const result = await repo.search({ origin: "lhr", destination: "jfk" });
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it("excludes offers without enough seats", async () => {
    const result = await repo.search({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2030-01-01",
      passengers: 2,
    });
    // off_TEST0002 only has a single seat left.
    expect(result.offers.map((o) => o.id)).toEqual(["off_TEST0001"]);
  });

  it("filters by cabin class and price ceiling", async () => {
    const business = await repo.search({ origin: "LHR", destination: "JFK", cabinClass: "business" });
    expect(business.offers.map((o) => o.id)).toEqual(["off_TEST0003"]);

    const cheap = await repo.search({ origin: "LHR", destination: "JFK", maxPrice: 400 });
    expect(cheap.offers.map((o) => o.id)).toEqual(["off_TEST0002"]);
  });

  it("falls back to nearby dates and says so", async () => {
    const result = await repo.search({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2030-01-03",
      dateFlexibilityDays: 2,
    });

    expect(result.usedDateFlexibility).toBe(true);
    // Widens one day at a time, so the nearest date comes first.
    expect(result.matchedDates).toEqual(["2030-01-02", "2030-01-01"]);
  });

  it("returns nothing for an unknown route", async () => {
    const result = await repo.search({ origin: "LHR", destination: "SYD" });
    expect(result.offers).toEqual([]);
    expect(result.usedDateFlexibility).toBe(false);
  });

  it("respects the result limit", async () => {
    const result = await repo.search({ origin: "LHR", destination: "JFK", limit: 1 });
    expect(result.offers).toHaveLength(1);
  });

  it("looks offers up by id and lists airports", async () => {
    await expect(repo.getOfferById("off_TEST0003")).resolves.toMatchObject({
      cabinClass: "business",
    });
    await expect(repo.getOfferById("off_NOPE")).resolves.toBeNull();
    await expect(repo.listAirports()).resolves.toHaveLength(2);
  });

  it("rolls dates forward so the dataset is always in the future", async () => {
    const rolled = new JsonFlightRepository({
      dataFile: FIXTURE,
      rollDates: true,
      now: () => new Date("2030-03-11T00:00:00Z"), // 69 days after baseDate
    });
    await rolled.init();

    const result = await rolled.search({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2030-03-11",
    });

    expect(result.usedDateFlexibility).toBe(false);
    expect(result.offers).toHaveLength(2);
    // Local wall-clock time is preserved by the shift.
    const first = result.offers.find((o) => o.id === "off_TEST0001");
    expect(first?.slices[0]?.departingAt).toBe("2030-03-11T09:00:00+00:00");
    expect(isoDateOf(first?.slices[0]?.arrivingAt ?? "")).toBe("2030-03-11");

    await rolled.close();
  });

  it("never shifts dates backwards when the dataset is still in the future", async () => {
    const rolled = new JsonFlightRepository({
      dataFile: FIXTURE,
      rollDates: true,
      now: () => new Date("2029-06-01T00:00:00Z"),
    });
    await rolled.init();

    const result = await rolled.search({
      origin: "LHR",
      destination: "JFK",
      departureDate: "2030-01-01",
    });
    expect(result.offers).toHaveLength(2);
    await rolled.close();
  });
});
