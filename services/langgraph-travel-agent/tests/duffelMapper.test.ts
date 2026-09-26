import { describe, expect, it } from "vitest";
import {
  isOfferExpired,
  mapDuffelAirport,
  mapDuffelOffer,
  parseIso8601DurationMinutes,
} from "../src/repositories/duffelMapper.js";
import type { DuffelOffer } from "../src/repositories/duffelTypes.js";

/** Shaped after a real Duffel v2 offer, trimmed to the fields we read. */
const DUFFEL_OFFER: DuffelOffer = {
  id: "off_00009htYpSCXrwaB9DnUm0",
  total_amount: "1842.77",
  total_currency: "GBP",
  expires_at: "2026-10-19T12:00:00Z",
  owner: { id: "arl_0000", iata_code: "BA", name: "British Airways" },
  conditions: {
    refund_before_departure: {
      allowed: true,
      penalty_amount: "100.00",
      penalty_currency: "GBP",
    },
  },
  slices: [
    {
      id: "sli_0000",
      origin: { iata_code: "LHR", name: "Heathrow", city_name: "London" },
      destination: { iata_code: "NRT", name: "Narita", city_name: "Tokyo" },
      duration: "PT11H50M",
      segments: [
        {
          id: "seg_0000",
          origin: { iata_code: "LHR" },
          destination: { iata_code: "NRT" },
          // Duffel returns airline-local time with no UTC offset.
          departing_at: "2026-10-20T11:30:00",
          arriving_at: "2026-10-21T07:20:00",
          duration: "PT11H50M",
          marketing_carrier: { iata_code: "BA", name: "British Airways" },
          marketing_carrier_flight_number: "005",
          aircraft: { iata_code: "789", name: "Boeing 787-9" },
          passengers: [
            {
              passenger_id: "pas_0000",
              cabin_class: "business",
              baggages: [
                { type: "checked", quantity: 2 },
                { type: "carry_on", quantity: 1 },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseIso8601DurationMinutes", () => {
  it("parses the hour/minute durations Duffel returns", () => {
    expect(parseIso8601DurationMinutes("PT11H50M")).toBe(710);
    expect(parseIso8601DurationMinutes("PT02H26M")).toBe(146);
    expect(parseIso8601DurationMinutes("PT45M")).toBe(45);
    expect(parseIso8601DurationMinutes("PT2H")).toBe(120);
  });

  it("handles day and week components", () => {
    expect(parseIso8601DurationMinutes("P1DT2H30M")).toBe(24 * 60 + 150);
    expect(parseIso8601DurationMinutes("P1W")).toBe(7 * 24 * 60);
  });

  it("rounds seconds to the nearest minute", () => {
    expect(parseIso8601DurationMinutes("PT1H30S")).toBe(61);
  });

  it("returns null rather than guessing for unusable input", () => {
    expect(parseIso8601DurationMinutes("11h50m")).toBeNull();
    expect(parseIso8601DurationMinutes("")).toBeNull();
    expect(parseIso8601DurationMinutes(null)).toBeNull();
    expect(parseIso8601DurationMinutes(undefined)).toBeNull();
    // Calendar-relative units have no fixed minute count.
    expect(parseIso8601DurationMinutes("P1M")).toBeNull();
  });
});

describe("mapDuffelOffer", () => {
  it("maps a Duffel offer onto the domain shape", () => {
    const offer = mapDuffelOffer(DUFFEL_OFFER, { passengers: 2 });

    expect(offer.id).toBe("off_00009htYpSCXrwaB9DnUm0");
    expect(offer.owner).toEqual({ iata: "BA", name: "British Airways" });
    expect(offer.totalAmount).toBe("1842.77");
    expect(offer.totalCurrency).toBe("GBP");
    expect(offer.cabinClass).toBe("business");
    expect(offer.refundable).toBe(true);
    expect(offer.baggageIncluded).toBe(2);
    expect(offer.expiresAt).toBe("2026-10-19T12:00:00Z");
  });

  it("composes the flight number from carrier and number", () => {
    const offer = mapDuffelOffer(DUFFEL_OFFER, { passengers: 1 });
    expect(offer.slices[0]?.segments[0]?.flightNumber).toBe("BA005");
  });

  it("carries Duffel's offset-free local timestamps through unchanged", () => {
    const slice = mapDuffelOffer(DUFFEL_OFFER, { passengers: 1 }).slices[0];
    expect(slice?.departingAt).toBe("2026-10-20T11:30:00");
    expect(slice?.arrivingAt).toBe("2026-10-21T07:20:00");
  });

  it("converts the ISO-8601 duration to minutes", () => {
    const offer = mapDuffelOffer(DUFFEL_OFFER, { passengers: 1 });
    expect(offer.slices[0]?.durationMinutes).toBe(710);
    expect(offer.slices[0]?.segments[0]?.durationMinutes).toBe(710);
  });

  it("reports seats as the number of travellers quoted for", () => {
    // Duffel does not publish remaining inventory; the offer is priced for
    // the requested party, so that is what the domain records.
    expect(mapDuffelOffer(DUFFEL_OFFER, { passengers: 3 }).seatsAvailable).toBe(3);
    expect(mapDuffelOffer(DUFFEL_OFFER, { passengers: 0 }).seatsAvailable).toBe(1);
  });

  it("treats a non-refundable or absent condition as non-refundable", () => {
    const notAllowed: DuffelOffer = {
      ...DUFFEL_OFFER,
      conditions: { refund_before_departure: { allowed: false } },
    };
    const unknown: DuffelOffer = { ...DUFFEL_OFFER, conditions: null };

    expect(mapDuffelOffer(notAllowed, { passengers: 1 }).refundable).toBe(false);
    expect(mapDuffelOffer(unknown, { passengers: 1 }).refundable).toBe(false);
  });

  it("derives slice times and duration from the segments of a connection", () => {
    const connecting: DuffelOffer = {
      ...DUFFEL_OFFER,
      slices: [
        {
          id: "sli_conn",
          origin: { iata_code: "LHR" },
          destination: { iata_code: "BOM" },
          duration: "PT13H05M",
          segments: [
            {
              id: "seg_1",
              origin: { iata_code: "LHR" },
              destination: { iata_code: "DXB" },
              departing_at: "2026-10-20T09:00:00",
              arriving_at: "2026-10-20T19:00:00",
              duration: "PT07H00M",
              marketing_carrier: { iata_code: "EK", name: "Emirates" },
              marketing_carrier_flight_number: "002",
              aircraft: { name: "Airbus A380" },
              passengers: [{ cabin_class: "economy", baggages: [{ type: "checked", quantity: 1 }] }],
            },
            {
              id: "seg_2",
              origin: { iata_code: "DXB" },
              destination: { iata_code: "BOM" },
              departing_at: "2026-10-20T21:00:00",
              arriving_at: "2026-10-21T01:35:00",
              duration: "PT03H05M",
              marketing_carrier: { iata_code: "EK", name: "Emirates" },
              marketing_carrier_flight_number: "500",
              aircraft: { name: "Boeing 777-300ER" },
              passengers: [{ cabin_class: "economy" }],
            },
          ],
        },
      ],
    };

    const slice = mapDuffelOffer(connecting, { passengers: 1 }).slices[0];

    expect(slice?.segments).toHaveLength(2);
    expect(slice?.origin).toBe("LHR");
    expect(slice?.destination).toBe("BOM");
    expect(slice?.departingAt).toBe("2026-10-20T09:00:00");
    expect(slice?.arrivingAt).toBe("2026-10-21T01:35:00");
    expect(slice?.durationMinutes).toBe(785);
    expect(slice?.segments.map((s) => s.flightNumber)).toEqual(["EK002", "EK500"]);
  });

  it("falls back to the timestamps when a duration is missing", () => {
    const noDuration: DuffelOffer = {
      ...DUFFEL_OFFER,
      slices: [
        {
          id: "sli_x",
          origin: { iata_code: "LHR" },
          destination: { iata_code: "CDG" },
          segments: [
            {
              id: "seg_x",
              origin: { iata_code: "LHR" },
              destination: { iata_code: "CDG" },
              departing_at: "2026-10-20T09:00:00Z",
              arriving_at: "2026-10-20T10:20:00Z",
              marketing_carrier: { iata_code: "AF", name: "Air France" },
              marketing_carrier_flight_number: "1681",
            },
          ],
        },
      ],
    };

    expect(mapDuffelOffer(noDuration, { passengers: 1 }).slices[0]?.durationMinutes).toBe(80);
  });

  it("survives a sparse payload without throwing", () => {
    const sparse: DuffelOffer = { id: "off_sparse" };
    const offer = mapDuffelOffer(sparse, { passengers: 1 });

    expect(offer.id).toBe("off_sparse");
    expect(offer.slices).toEqual([]);
    expect(offer.totalCurrency).toBe("USD");
    expect(offer.owner.name).toBe("Unknown airline");
    expect(offer.baggageIncluded).toBe(0);
  });

  it("uses the requested cabin when no segment reports one", () => {
    const noCabin: DuffelOffer = {
      ...DUFFEL_OFFER,
      slices: [{ id: "s", segments: [{ id: "g", passengers: [] }] }],
    };
    expect(mapDuffelOffer(noCabin, { passengers: 1, fallbackCabin: "first" }).cabinClass).toBe(
      "first",
    );
    expect(mapDuffelOffer(noCabin, { passengers: 1 }).cabinClass).toBe("economy");
  });
});

describe("isOfferExpired", () => {
  it("detects a lapsed quote", () => {
    const offer = mapDuffelOffer(DUFFEL_OFFER, { passengers: 1 });
    expect(isOfferExpired(offer, new Date("2026-10-19T11:59:00Z"))).toBe(false);
    expect(isOfferExpired(offer, new Date("2026-10-19T12:00:01Z"))).toBe(true);
  });

  it("treats a missing or unparseable expiry as not expired", () => {
    const offer = mapDuffelOffer({ id: "off_x" }, { passengers: 1 });
    expect(isOfferExpired(offer, new Date())).toBe(false);
    expect(isOfferExpired({ ...offer, expiresAt: "not-a-date" }, new Date())).toBe(false);
  });
});

describe("mapDuffelAirport", () => {
  it("maps the airport catalogue entry", () => {
    expect(
      mapDuffelAirport({
        iata_code: "LHR",
        name: "Heathrow",
        city_name: "London",
        iata_country_code: "GB",
        time_zone: "Europe/London",
      }),
    ).toEqual({
      iata: "LHR",
      name: "Heathrow",
      city: "London",
      country: "GB",
      timeZone: "Europe/London",
    });
  });

  it("falls back to the nested city object", () => {
    expect(mapDuffelAirport({ iata_code: "JFK", city: { name: "New York" } }).city).toBe(
      "New York",
    );
  });
});
