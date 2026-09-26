import pg from "pg";
import type {
  Airport,
  FlightOffer,
  FlightSearchQuery,
  FlightSearchResult,
} from "../domain/types.js";
import { addDaysToIsoDate, isoDateOf } from "../util/time.js";
import {
  DEFAULT_DATE_FLEXIBILITY_DAYS,
  type FlightRepository,
} from "./FlightRepository.js";
import { buildFlightSearchSql } from "./postgresQuery.js";

export interface PostgresFlightRepositoryOptions {
  connectionString: string;
  poolMax?: number;
  ssl?: boolean;
}

/**
 * Postgres-backed inventory, reading the `flight_offer_json` view defined in
 * `db/schema.sql`.
 *
 * Selected with `FLIGHT_REPOSITORY=postgres`; it implements exactly the same
 * `FlightRepository` contract as `JsonFlightRepository`, so no LangGraph node
 * changes when you switch.
 */
export class PostgresFlightRepository implements FlightRepository {
  readonly name = "postgres";

  private readonly pool: pg.Pool;

  constructor(options: PostgresFlightRepositoryOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolMax ?? 10,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      application_name: "langgraph-travel-agent",
    });
  }

  async init(): Promise<void> {
    // Fail fast at boot rather than on the first user request.
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1 FROM flight_offer_json LIMIT 1");
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    try {
      const result = await this.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM flight_offers",
      );
      return { healthy: true, detail: `${result.rows[0]?.count ?? "0"} offers` };
    } catch (error) {
      return {
        healthy: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async search(query: FlightSearchQuery): Promise<FlightSearchResult> {
    const departureDate = query.departureDate;

    if (!departureDate) {
      const offers = await this.runSearch(query);
      return { offers, usedDateFlexibility: false, matchedDates: datesOf(offers) };
    }

    const exact = await this.runSearch(query, { from: departureDate, to: departureDate });
    if (exact.length > 0) {
      return { offers: exact, usedDateFlexibility: false, matchedDates: [departureDate] };
    }

    const flexibility = query.dateFlexibilityDays ?? DEFAULT_DATE_FLEXIBILITY_DAYS;
    const nearby = await this.runSearch(query, {
      from: addDaysToIsoDate(departureDate, -flexibility),
      to: addDaysToIsoDate(departureDate, flexibility),
    });
    return {
      offers: nearby,
      usedDateFlexibility: nearby.length > 0,
      matchedDates: datesOf(nearby),
    };
  }

  async getOfferById(id: string): Promise<FlightOffer | null> {
    const result = await this.pool.query<{ payload: FlightOffer }>(
      "SELECT payload FROM flight_offer_json WHERE id = $1",
      [id],
    );
    return result.rows[0]?.payload ?? null;
  }

  async listAirports(): Promise<Airport[]> {
    const result = await this.pool.query<{
      iata: string;
      name: string;
      city: string;
      country: string;
      time_zone: string;
    }>("SELECT iata, name, city, country, time_zone FROM airports ORDER BY iata");
    return result.rows.map((row) => ({
      iata: row.iata,
      name: row.name,
      city: row.city,
      country: row.country,
      timeZone: row.time_zone,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async runSearch(
    query: FlightSearchQuery,
    window?: { from: string; to: string },
  ): Promise<FlightOffer[]> {
    const statement = buildFlightSearchSql(query, window);
    const result = await this.pool.query<{ payload: FlightOffer }>(
      statement.text,
      statement.values,
    );
    return result.rows.map((row) => row.payload);
  }
}

function datesOf(offers: FlightOffer[]): string[] {
  return [...new Set(offers.map((offer) => isoDateOf(offer.slices[0]?.departingAt ?? "")))];
}
