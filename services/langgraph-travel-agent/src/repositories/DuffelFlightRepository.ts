import type {
  Airport,
  CabinClass,
  FlightOffer,
  FlightSearchQuery,
  FlightSearchResult,
} from "../domain/types.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import { addDaysToIsoDate, isoDateOf, todayIsoDate } from "../util/time.js";
import {
  DEFAULT_DATE_FLEXIBILITY_DAYS,
  DEFAULT_SEARCH_LIMIT,
  type FlightRepository,
} from "./FlightRepository.js";
import { isOfferExpired, mapDuffelAirport, mapDuffelOffer } from "./duffelMapper.js";
import type {
  DuffelAirportListResponse,
  DuffelErrorResponse,
  DuffelOffer,
  DuffelOfferRequestResponse,
  DuffelOfferResponse,
} from "./duffelTypes.js";

export interface DuffelFlightRepositoryOptions {
  /** Duffel access token (duffel_test_… or duffel_live_…). Never logged. */
  accessToken: string;
  baseUrl?: string;
  /** Value of the required `Duffel-Version` header. */
  apiVersion?: string;
  /** Our own abort deadline for a single HTTP call. */
  timeoutMs?: number;
  /** How long Duffel waits on each airline. Must be below `timeoutMs`. */
  supplierTimeoutMs?: number;
  maxConnections?: number;
  /**
   * How many extra offer requests to spend looking at adjacent dates when the
   * requested date returns nothing. 0 disables the behaviour — each retry is
   * a paid, multi-second call.
   */
  maxFlexibilityRequests?: number;
  /** `/health` is polled every few seconds; the probe result is cached. */
  healthCacheMs?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock, for expiry filtering and the default departure date. */
  now?: () => Date;
}

export class DuffelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Duffel request timed out after ${timeoutMs}ms`);
    this.name = "DuffelTimeoutError";
  }
}

export class DuffelRequestError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, detail: string, requestId?: string) {
    super(`Duffel request failed with HTTP ${status}: ${detail}`);
    this.name = "DuffelRequestError";
    this.status = status;
    this.requestId = requestId;
  }
}

interface OfferRequestBody {
  data: {
    slices: Array<{ origin: string; destination: string; departure_date: string }>;
    passengers: Array<{ type: "adult" }>;
    cabin_class?: CabinClass;
    max_connections?: number;
  };
}

/**
 * Live flight inventory from Duffel (https://duffel.com/docs/api/v2).
 *
 * Selected with `FLIGHT_REPOSITORY=duffel`. It satisfies exactly the same
 * `FlightRepository` contract as the JSON and Postgres drivers, so no
 * LangGraph node changes when you switch.
 *
 * Search is Duffel's offer-request flow: `POST /air/offer_requests` with
 * `return_offers=true` returns the offers inline, in one round trip. Filters
 * Duffel has no server-side parameter for (price ceiling, result limit,
 * cheapest-first ordering) are applied here after mapping.
 */
export class DuffelFlightRepository implements FlightRepository {
  readonly name = "duffel";

  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly supplierTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxFlexibilityRequests: number;
  private readonly healthCacheMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  private airportCache: Airport[] | null = null;
  private lastHealth: { at: number; healthy: boolean; detail: string } | null = null;

  constructor(options: DuffelFlightRepositoryOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? "https://api.duffel.com").replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? "v2";
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.supplierTimeoutMs = options.supplierTimeoutMs ?? 20_000;
    this.maxConnections = options.maxConnections ?? 1;
    this.maxFlexibilityRequests = options.maxFlexibilityRequests ?? 2;
    this.healthCacheMs = options.healthCacheMs ?? 60_000;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Validates the token at boot rather than on a traveller's first request. */
  async init(): Promise<void> {
    if (this.accessToken.trim() === "") {
      throw new Error("DuffelFlightRepository requires DUFFEL_ACCESS_TOKEN");
    }
    await this.request<DuffelAirportListResponse>("GET", "/air/airports?limit=1");
    this.lastHealth = { at: this.now().getTime(), healthy: true, detail: "token accepted" };
    this.logger.info("duffel repository ready", {
      baseUrl: this.baseUrl,
      apiVersion: this.apiVersion,
      // Say which environment the token targets, never the token.
      mode: this.accessToken.startsWith("duffel_live") ? "live" : "test",
    });
  }

  /**
   * Kubernetes polls /health every few seconds. Calling Duffel that often
   * would burn rate limit for no benefit, so a successful probe is cached.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    const cached = this.lastHealth;
    if (cached && this.now().getTime() - cached.at < this.healthCacheMs) {
      return { healthy: cached.healthy, detail: `${cached.detail} (cached)` };
    }

    try {
      await this.request<DuffelAirportListResponse>("GET", "/air/airports?limit=1");
      this.lastHealth = { at: this.now().getTime(), healthy: true, detail: "token accepted" };
      return { healthy: true, detail: "token accepted" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastHealth = { at: this.now().getTime(), healthy: false, detail };
      return { healthy: false, detail };
    }
  }

  async search(query: FlightSearchQuery): Promise<FlightSearchResult> {
    const passengers = Math.max(1, query.passengers ?? 1);
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;

    // Duffel requires a concrete departure date - there is no "any date"
    // search - so an undated request is quoted for today.
    const requestedDate = query.departureDate ?? todayIsoDate(this.now());

    const exact = await this.searchOnDate(query, requestedDate, passengers);
    if (exact.length > 0) {
      return {
        offers: exact.slice(0, limit),
        usedDateFlexibility: false,
        matchedDates: uniqueDates(exact.slice(0, limit)),
      };
    }

    // Widen one day at a time, nearest first. Each attempt is a paid,
    // multi-second call, so the number of them is capped by configuration.
    const flexibilityDays = query.dateFlexibilityDays ?? DEFAULT_DATE_FLEXIBILITY_DAYS;
    const candidates = adjacentDates(requestedDate, flexibilityDays).slice(
      0,
      this.maxFlexibilityRequests,
    );

    for (const date of candidates) {
      const offers = await this.searchOnDate(query, date, passengers);
      if (offers.length > 0) {
        this.logger.debug("duffel date flexibility hit", { requestedDate, matchedDate: date });
        return {
          offers: offers.slice(0, limit),
          usedDateFlexibility: true,
          matchedDates: uniqueDates(offers.slice(0, limit)),
        };
      }
    }

    return { offers: [], usedDateFlexibility: false, matchedDates: [] };
  }

  async getOfferById(id: string): Promise<FlightOffer | null> {
    try {
      const response = await this.request<DuffelOfferResponse>(
        "GET",
        `/air/offers/${encodeURIComponent(id)}`,
      );
      const offer = response.data;
      return offer ? mapDuffelOffer(offer, { passengers: 1 }) : null;
    } catch (error) {
      if (error instanceof DuffelRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /** Cached after the first call; the catalogue changes very rarely. */
  async listAirports(): Promise<Airport[]> {
    if (this.airportCache) return this.airportCache;

    const airports: Airport[] = [];
    let after: string | null = null;
    // Hard page cap: this list is informational, not worth unbounded paging.
    for (let page = 0; page < 3; page += 1) {
      const path: string = after
        ? `/air/airports?limit=200&after=${encodeURIComponent(after)}`
        : "/air/airports?limit=200";
      const response: DuffelAirportListResponse =
        await this.request<DuffelAirportListResponse>("GET", path);

      for (const airport of response.data ?? []) {
        if (airport.iata_code) airports.push(mapDuffelAirport(airport));
      }

      after = response.meta?.after ?? null;
      if (!after) break;
    }

    this.airportCache = airports;
    return airports;
  }

  async close(): Promise<void> {
    this.airportCache = null;
    this.lastHealth = null;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async searchOnDate(
    query: FlightSearchQuery,
    departureDate: string,
    passengers: number,
  ): Promise<FlightOffer[]> {
    const body: OfferRequestBody = {
      data: {
        slices: [
          {
            origin: query.origin.toUpperCase(),
            destination: query.destination.toUpperCase(),
            departure_date: departureDate,
          },
        ],
        passengers: Array.from({ length: passengers }, () => ({ type: "adult" as const })),
        max_connections: this.maxConnections,
        ...(query.cabinClass ? { cabin_class: query.cabinClass } : {}),
      },
    };

    const path =
      `/air/offer_requests?return_offers=true&supplier_timeout=${this.supplierTimeoutMs}`;
    const response = await this.request<DuffelOfferRequestResponse>("POST", path, body);
    const rawOffers: DuffelOffer[] = response.data?.offers ?? [];

    const now = this.now();
    const offers = rawOffers
      .map((offer) =>
        mapDuffelOffer(offer, {
          passengers,
          ...(query.cabinClass ? { fallbackCabin: query.cabinClass } : {}),
        }),
      )
      // A lapsed quote is not bookable; never present one as if it were.
      .filter((offer) => !isOfferExpired(offer, now))
      .filter((offer) => matchesFilters(offer, query))
      // Duffel does not guarantee an ordering, and the agent presents
      // cheapest-first, matching the other drivers.
      .sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));

    this.logger.debug("duffel offer request completed", {
      departureDate,
      returned: rawOffers.length,
      kept: offers.length,
    });

    return offers;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Duffel-Version": this.apiVersion,
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const { detail, requestId } = await readDuffelError(response);
        throw new DuffelRequestError(response.status, detail, requestId);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new DuffelTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function matchesFilters(offer: FlightOffer, query: FlightSearchQuery): boolean {
  if (query.maxPrice !== undefined && Number(offer.totalAmount) > query.maxPrice) return false;
  if (query.currency && offer.totalCurrency.toUpperCase() !== query.currency.toUpperCase()) {
    return false;
  }
  return true;
}

function uniqueDates(offers: FlightOffer[]): string[] {
  return [...new Set(offers.map((offer) => isoDateOf(offer.slices[0]?.departingAt ?? "")))];
}

/** [-1, +1, -2, +2, …] around `date`, nearest first. */
function adjacentDates(date: string, flexibilityDays: number): string[] {
  const dates: string[] = [];
  for (let delta = 1; delta <= flexibilityDays; delta += 1) {
    dates.push(addDaysToIsoDate(date, -delta), addDaysToIsoDate(date, delta));
  }
  return dates;
}

/**
 * Extracts a readable reason from Duffel's error envelope. Only the API's own
 * message is surfaced - the request never echoes the token back, and nothing
 * here reads it.
 */
async function readDuffelError(
  response: Response,
): Promise<{ detail: string; requestId: string | undefined }> {
  try {
    const payload = (await response.json()) as DuffelErrorResponse;
    const first = payload.errors?.[0];
    const detail =
      [first?.title, first?.message].filter(Boolean).join(" - ") ||
      first?.code ||
      response.statusText ||
      "unknown error";
    return { detail, requestId: payload.meta?.request_id };
  } catch {
    return { detail: response.statusText || "unreadable error body", requestId: undefined };
  }
}
