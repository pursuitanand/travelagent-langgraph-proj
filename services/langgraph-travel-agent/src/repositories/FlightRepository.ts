import type {
  Airport,
  FlightOffer,
  FlightSearchQuery,
  FlightSearchResult,
} from "../domain/types.js";

/**
 * Storage-agnostic access to flight inventory.
 *
 * The LangGraph nodes depend on this interface only, never on a concrete
 * implementation, so `JsonFlightRepository` can be swapped for
 * `PostgresFlightRepository` (or a live Duffel client) by changing the factory
 * in `repositories/index.ts` alone.
 */
export interface FlightRepository {
  /** Human-readable driver name, surfaced on /health. */
  readonly name: string;

  /** Opens connections / loads data. Called once during server start-up. */
  init(): Promise<void>;

  /** Cheap liveness probe for the readiness endpoint. */
  healthCheck(): Promise<{ healthy: boolean; detail: string }>;

  search(query: FlightSearchQuery): Promise<FlightSearchResult>;

  getOfferById(id: string): Promise<FlightOffer | null>;

  listAirports(): Promise<Airport[]>;

  /** Releases connections. Called on SIGTERM. */
  close(): Promise<void>;
}

export const DEFAULT_SEARCH_LIMIT = 6;
export const DEFAULT_DATE_FLEXIBILITY_DAYS = 2;
