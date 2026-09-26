import { describe, expect, it, vi } from "vitest";
import {
  DuffelFlightRepository,
  DuffelRequestError,
  DuffelTimeoutError,
} from "../src/repositories/DuffelFlightRepository.js";
import type { DuffelOffer } from "../src/repositories/duffelTypes.js";

const TOKEN = "duffel_test_SECRETVALUE123";
const NOW = new Date("2026-09-25T10:00:00Z");

function offer(id: string, amount: string, date = "2026-10-20"): DuffelOffer {
  return {
    id,
    total_amount: amount,
    total_currency: "GBP",
    expires_at: "2027-01-01T00:00:00Z",
    owner: { iata_code: "BA", name: "British Airways" },
    conditions: { refund_before_departure: { allowed: false } },
    slices: [
      {
        id: `sli_${id}`,
        origin: { iata_code: "LHR" },
        destination: { iata_code: "NRT" },
        duration: "PT11H50M",
        segments: [
          {
            id: `seg_${id}`,
            origin: { iata_code: "LHR" },
            destination: { iata_code: "NRT" },
            departing_at: `${date}T11:30:00`,
            arriving_at: `${date}T23:20:00`,
            duration: "PT11H50M",
            marketing_carrier: { iata_code: "BA", name: "British Airways" },
            marketing_carrier_flight_number: "005",
            aircraft: { name: "Boeing 787-9" },
            passengers: [{ cabin_class: "economy", baggages: [{ type: "checked", quantity: 1 }] }],
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function offersResponse(offers: DuffelOffer[]): Response {
  return jsonResponse({ data: { id: "orq_123", offers } });
}

function buildRepo(
  fetchImpl: unknown,
  overrides: Partial<ConstructorParameters<typeof DuffelFlightRepository>[0]> = {},
) {
  return new DuffelFlightRepository({
    accessToken: TOKEN,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => NOW,
    ...overrides,
  });
}

describe("DuffelFlightRepository — request construction", () => {
  it("sends the documented headers, including the version header", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([offer("off_1", "500.00")]));
    const repo = buildRepo(fetchImpl);

    await repo.search({ origin: "lhr", destination: "nrt", departureDate: "2026-10-20" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toContain("https://api.duffel.com/air/offer_requests");
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Duffel-Version"]).toBe("v2");
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("asks for the offers inline and bounds the supplier wait", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([]));
    const repo = buildRepo(fetchImpl, { supplierTimeoutMs: 9000, maxFlexibilityRequests: 0 });

    await repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("return_offers=true");
    expect(url).toContain("supplier_timeout=9000");
  });

  it("builds the offer-request body from the query", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([offer("off_1", "500.00")]));
    const repo = buildRepo(fetchImpl, { maxConnections: 0 });

    await repo.search({
      origin: "lhr",
      destination: "nrt",
      departureDate: "2026-10-20",
      passengers: 3,
      cabinClass: "business",
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      data: {
        slices: [{ origin: "LHR", destination: "NRT", departure_date: "2026-10-20" }],
        passengers: [{ type: "adult" }, { type: "adult" }, { type: "adult" }],
        max_connections: 0,
        cabin_class: "business",
      },
    });
  });

  it("omits cabin_class when the traveller did not state one", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([offer("off_1", "500.00")]));
    const repo = buildRepo(fetchImpl);

    await repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).data).not.toHaveProperty("cabin_class");
  });

  it("quotes today when no departure date was parsed", async () => {
    // Duffel has no "any date" search, so the clock supplies one.
    const fetchImpl = vi.fn(async () => offersResponse([offer("off_1", "500.00")]));
    const repo = buildRepo(fetchImpl);

    await repo.search({ origin: "LHR", destination: "NRT" });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).data.slices[0].departure_date).toBe("2026-09-25");
  });
});

describe("DuffelFlightRepository — results", () => {
  it("maps offers and returns them cheapest first", async () => {
    const fetchImpl = vi.fn(async () =>
      offersResponse([offer("off_mid", "900.00"), offer("off_cheap", "410.00")]),
    );
    const repo = buildRepo(fetchImpl);

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
    });

    expect(result.offers.map((o) => o.id)).toEqual(["off_cheap", "off_mid"]);
    expect(result.usedDateFlexibility).toBe(false);
    expect(result.matchedDates).toEqual(["2026-10-20"]);
    expect(result.offers[0]?.slices[0]?.segments[0]?.flightNumber).toBe("BA005");
  });

  it("applies the price ceiling Duffel cannot filter server-side", async () => {
    const fetchImpl = vi.fn(async () =>
      offersResponse([offer("off_cheap", "410.00"), offer("off_pricey", "2400.00")]),
    );
    const repo = buildRepo(fetchImpl);

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
      maxPrice: 500,
    });

    expect(result.offers.map((o) => o.id)).toEqual(["off_cheap"]);
  });

  it("respects the result limit", async () => {
    const fetchImpl = vi.fn(async () =>
      offersResponse([offer("a", "100.00"), offer("b", "200.00"), offer("c", "300.00")]),
    );
    const repo = buildRepo(fetchImpl);

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
      limit: 2,
    });

    expect(result.offers).toHaveLength(2);
  });

  it("drops offers whose quote has already expired", async () => {
    const stale = { ...offer("off_stale", "100.00"), expires_at: "2026-09-01T00:00:00Z" };
    const fetchImpl = vi.fn(async () => offersResponse([stale, offer("off_live", "900.00")]));
    const repo = buildRepo(fetchImpl);

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
    });

    expect(result.offers.map((o) => o.id)).toEqual(["off_live"]);
  });
});

describe("DuffelFlightRepository — date flexibility", () => {
  it("tries adjacent dates, nearest first, when the requested date is empty", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const date = JSON.parse(init.body as string).data.slices[0].departure_date as string;
      return date === "2026-10-19"
        ? offersResponse([offer("off_prev", "450.00", "2026-10-19")])
        : offersResponse([]);
    });
    const repo = buildRepo(fetchImpl);

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
    });

    expect(result.usedDateFlexibility).toBe(true);
    expect(result.matchedDates).toEqual(["2026-10-19"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // requested date, then day -1
  });

  it("never spends more than the configured number of extra requests", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([]));
    const repo = buildRepo(fetchImpl, { maxFlexibilityRequests: 1 });

    const result = await repo.search({
      origin: "LHR",
      destination: "NRT",
      departureDate: "2026-10-20",
      dateFlexibilityDays: 5,
    });

    expect(result.offers).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 requested + 1 retry
  });

  it("makes no extra calls when flexibility is switched off", async () => {
    const fetchImpl = vi.fn(async () => offersResponse([]));
    const repo = buildRepo(fetchImpl, { maxFlexibilityRequests: 0 });

    await repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("DuffelFlightRepository — errors", () => {
  it("raises a typed error carrying Duffel's own message and request id", async () => {
    const fetchImpl = async () =>
      jsonResponse(
        {
          errors: [{ title: "Unauthorized", message: "The access token is invalid" }],
          meta: { request_id: "req_abc" },
        },
        401,
      );
    const repo = buildRepo(fetchImpl);

    await expect(
      repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" }),
    ).rejects.toMatchObject({
      name: "DuffelRequestError",
      status: 401,
      requestId: "req_abc",
    });
  });

  it("never puts the access token into an error message", async () => {
    const fetchImpl = async () =>
      jsonResponse({ errors: [{ title: "Rate limit exceeded" }] }, 429);
    const repo = buildRepo(fetchImpl);

    let caught: unknown;
    try {
      await repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DuffelRequestError);
    const error = caught as DuffelRequestError;
    expect(error.status).toBe(429);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("Rate limit exceeded");
  });

  it("copes with an unreadable error body", async () => {
    const fetchImpl = async () => new Response("<html>502</html>", { status: 502 });
    const repo = buildRepo(fetchImpl);

    await expect(
      repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" }),
    ).rejects.toBeInstanceOf(DuffelRequestError);
  });

  it("raises a typed timeout when the request is aborted", async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const repo = buildRepo(fetchImpl, { timeoutMs: 10, supplierTimeoutMs: 5 });

    await expect(
      repo.search({ origin: "LHR", destination: "NRT", departureDate: "2026-10-20" }),
    ).rejects.toBeInstanceOf(DuffelTimeoutError);
  });
});

describe("DuffelFlightRepository — lifecycle", () => {
  it("rejects an empty token at start-up instead of at first request", async () => {
    const repo = buildRepo(vi.fn(), { accessToken: "  " });
    await expect(repo.init()).rejects.toThrow(/DUFFEL_ACCESS_TOKEN/);
  });

  it("probes the API during init so a bad token fails the pod, not the user", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const repo = buildRepo(fetchImpl);

    await repo.init();

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.duffel.com/air/airports?limit=1");
  });

  it("caches the health probe so Kubernetes does not hammer the API", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const repo = buildRepo(fetchImpl, { healthCacheMs: 60_000 });

    await repo.init();
    const first = await repo.healthCheck();
    const second = await repo.healthCheck();

    expect(first.healthy).toBe(true);
    expect(second.healthy).toBe(true);
    expect(second.detail).toContain("cached");
    // Only the init() probe hit the network.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the cache window has passed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    let clock = NOW.getTime();
    const repo = buildRepo(fetchImpl, {
      healthCacheMs: 1000,
      now: () => new Date(clock),
    });

    await repo.healthCheck();
    clock += 5000;
    await repo.healthCheck();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports unhealthy rather than throwing when the API rejects the token", async () => {
    const fetchImpl = async () => jsonResponse({ errors: [{ title: "Unauthorized" }] }, 401);
    const repo = buildRepo(fetchImpl);

    const health = await repo.healthCheck();

    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("401");
  });

  it("fetches a single offer by id and maps 404 to null", async () => {
    const found = vi.fn(async () => jsonResponse({ data: offer("off_9", "700.00") }));
    await expect(buildRepo(found).getOfferById("off_9")).resolves.toMatchObject({ id: "off_9" });
    const [url] = found.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.duffel.com/air/offers/off_9");

    const missing = async () => jsonResponse({ errors: [{ title: "Not found" }] }, 404);
    await expect(buildRepo(missing).getOfferById("off_nope")).resolves.toBeNull();
  });

  it("pages the airport catalogue and caches it", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("after=")
        ? jsonResponse({ data: [{ iata_code: "NRT", name: "Narita" }], meta: { after: null } })
        : jsonResponse({
            data: [{ iata_code: "LHR", name: "Heathrow", iata_country_code: "GB" }],
            meta: { after: "cursor1" },
          }),
    );
    const repo = buildRepo(fetchImpl);

    const first = await repo.listAirports();
    const second = await repo.listAirports();

    expect(first.map((a) => a.iata)).toEqual(["LHR", "NRT"]);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // cached on the second call
  });
});
