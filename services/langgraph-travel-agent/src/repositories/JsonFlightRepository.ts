import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Airport,
  FlightOffer,
  FlightSearchQuery,
  FlightSearchResult,
} from "../domain/types.js";
import {
  addDaysToIsoDate,
  daysBetweenIsoDates,
  isoDateOf,
  shiftIsoTimestampDays,
  todayIsoDate,
} from "../util/time.js";
import {
  DEFAULT_DATE_FLEXIBILITY_DAYS,
  DEFAULT_SEARCH_LIMIT,
  type FlightRepository,
} from "./FlightRepository.js";

export interface FlightDataset {
  version: number;
  baseDate: string;
  horizonDays: number;
  defaultCurrency: string;
  airports: Airport[];
  offers: FlightOffer[];
}

export interface JsonFlightRepositoryOptions {
  /** Path to the dataset, relative to the process cwd unless absolute. */
  dataFile: string;
  /**
   * When true the dataset is shifted so that its first day becomes today,
   * keeping the committed demo data permanently in the future.
   */
  rollDates?: boolean;
  /** Injectable clock, so tests are not time-dependent. */
  now?: () => Date;
}

function routeKey(origin: string, destination: string): string {
  return `${origin.toUpperCase()}-${destination.toUpperCase()}`;
}

/** Shifts every timestamp on an offer by `days`, preserving local wall clock. */
function shiftOffer(offer: FlightOffer, days: number): FlightOffer {
  return {
    ...offer,
    expiresAt: shiftIsoTimestampDays(offer.expiresAt, days),
    slices: offer.slices.map((slice) => ({
      ...slice,
      departingAt: shiftIsoTimestampDays(slice.departingAt, days),
      arrivingAt: shiftIsoTimestampDays(slice.arrivingAt, days),
      segments: slice.segments.map((segment) => ({
        ...segment,
        departingAt: shiftIsoTimestampDays(segment.departingAt, days),
        arrivingAt: shiftIsoTimestampDays(segment.arrivingAt, days),
      })),
    })),
  };
}

/**
 * Reads Duffel-shaped offers from a JSON file and serves them from in-memory
 * indexes. Suitable for local development, CI and demos; the Postgres
 * implementation is a drop-in replacement for real deployments.
 */
export class JsonFlightRepository implements FlightRepository {
  readonly name = "json";

  private readonly dataFile: string;
  private readonly rollDates: boolean;
  private readonly now: () => Date;

  private airports: Airport[] = [];
  private byRoute = new Map<string, FlightOffer[]>();
  private byId = new Map<string, FlightOffer>();
  private loaded = false;
  private appliedDayShift = 0;

  constructor(options: JsonFlightRepositoryOptions) {
    this.dataFile = resolve(process.cwd(), options.dataFile);
    this.rollDates = options.rollDates ?? true;
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    const raw = await readFile(this.dataFile, "utf8");
    const dataset = JSON.parse(raw) as FlightDataset;

    if (!Array.isArray(dataset.offers) || dataset.offers.length === 0) {
      throw new Error(`Flight dataset at ${this.dataFile} contains no offers`);
    }

    this.appliedDayShift = this.rollDates
      ? Math.max(0, daysBetweenIsoDates(dataset.baseDate, todayIsoDate(this.now())))
      : 0;

    this.airports = dataset.airports ?? [];
    this.byRoute = new Map();
    this.byId = new Map();

    for (const original of dataset.offers) {
      const offer =
        this.appliedDayShift === 0 ? original : shiftOffer(original, this.appliedDayShift);
      const slice = offer.slices[0];
      if (!slice) continue;

      const key = routeKey(slice.origin, slice.destination);
      const bucket = this.byRoute.get(key);
      if (bucket) bucket.push(offer);
      else this.byRoute.set(key, [offer]);

      this.byId.set(offer.id, offer);
    }

    // Cheapest first is the most useful default ordering for the agent.
    for (const bucket of this.byRoute.values()) {
      bucket.sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));
    }

    this.loaded = true;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return this.loaded
      ? {
          healthy: true,
          detail: `${this.byId.size} offers on ${this.byRoute.size} routes (day shift +${this.appliedDayShift})`,
        }
      : { healthy: false, detail: "dataset not loaded" };
  }

  async search(query: FlightSearchQuery): Promise<FlightSearchResult> {
    this.assertLoaded();

    const bucket = this.byRoute.get(routeKey(query.origin, query.destination)) ?? [];
    if (bucket.length === 0) {
      return { offers: [], usedDateFlexibility: false, matchedDates: [] };
    }

    const passengers = query.passengers ?? 1;
    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
    const flexibility = query.dateFlexibilityDays ?? DEFAULT_DATE_FLEXIBILITY_DAYS;

    const matchesNonDateFilters = (offer: FlightOffer): boolean => {
      if (offer.seatsAvailable < passengers) return false;
      if (query.cabinClass && offer.cabinClass !== query.cabinClass) return false;
      if (query.maxPrice !== undefined && Number(offer.totalAmount) > query.maxPrice) {
        return false;
      }
      return true;
    };

    const departureDate = query.departureDate;
    if (!departureDate) {
      const offers = bucket.filter(matchesNonDateFilters).slice(0, limit);
      return {
        offers,
        usedDateFlexibility: false,
        matchedDates: [...new Set(offers.map((o) => isoDateOf(o.slices[0]?.departingAt ?? "")))],
      };
    }

    const onDate = (offer: FlightOffer, date: string): boolean =>
      isoDateOf(offer.slices[0]?.departingAt ?? "") === date;

    const exact = bucket.filter((o) => matchesNonDateFilters(o) && onDate(o, departureDate));
    if (exact.length > 0) {
      return {
        offers: exact.slice(0, limit),
        usedDateFlexibility: false,
        matchedDates: [departureDate],
      };
    }

    // Widen day by day so the nearest alternatives come first.
    const nearby: FlightOffer[] = [];
    for (let delta = 1; delta <= flexibility && nearby.length < limit; delta += 1) {
      for (const date of [
        addDaysToIsoDate(departureDate, -delta),
        addDaysToIsoDate(departureDate, delta),
      ]) {
        nearby.push(...bucket.filter((o) => matchesNonDateFilters(o) && onDate(o, date)));
      }
    }

    const offers = nearby.slice(0, limit);
    return {
      offers,
      usedDateFlexibility: offers.length > 0,
      matchedDates: [...new Set(offers.map((o) => isoDateOf(o.slices[0]?.departingAt ?? "")))],
    };
  }

  async getOfferById(id: string): Promise<FlightOffer | null> {
    this.assertLoaded();
    return this.byId.get(id) ?? null;
  }

  async listAirports(): Promise<Airport[]> {
    this.assertLoaded();
    return this.airports;
  }

  async close(): Promise<void> {
    this.byRoute.clear();
    this.byId.clear();
    this.loaded = false;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("JsonFlightRepository.init() must be awaited before use");
    }
  }
}
