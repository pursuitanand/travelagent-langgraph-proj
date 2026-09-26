import type { AppConfig } from "../config/env.js";
import type { Logger } from "../util/logger.js";
import type { FlightRepository } from "./FlightRepository.js";
import { DuffelFlightRepository } from "./DuffelFlightRepository.js";
import { JsonFlightRepository } from "./JsonFlightRepository.js";
import { PostgresFlightRepository } from "./PostgresFlightRepository.js";

export type { FlightRepository } from "./FlightRepository.js";
export { DuffelFlightRepository } from "./DuffelFlightRepository.js";
export { JsonFlightRepository } from "./JsonFlightRepository.js";
export { PostgresFlightRepository } from "./PostgresFlightRepository.js";
export { buildFlightSearchSql } from "./postgresQuery.js";
export { mapDuffelOffer, parseIso8601DurationMinutes } from "./duffelMapper.js";

/**
 * The single place that knows which storage backend is in use. Swapping JSON
 * for Postgres is a configuration change (FLIGHT_REPOSITORY=postgres) plus this
 * factory - the LangGraph nodes are untouched.
 */
export function createFlightRepository(
  config: AppConfig,
  logger: Logger,
): FlightRepository {
  if (config.flights.driver === "duffel") {
    logger.info("using duffel flight repository", {
      endpoint: config.duffel.endpoint,
      apiVersion: config.duffel.apiVersion,
    });
    return new DuffelFlightRepository({
      accessToken: config.duffel.accessToken,
      baseUrl: config.duffel.endpoint,
      apiVersion: config.duffel.apiVersion,
      timeoutMs: config.duffel.timeoutMs,
      supplierTimeoutMs: config.duffel.supplierTimeoutMs,
      maxConnections: config.duffel.maxConnections,
      maxFlexibilityRequests: config.duffel.maxFlexibilityRequests,
      healthCacheMs: config.duffel.healthCacheMs,
      logger,
    });
  }

  if (config.flights.driver === "postgres") {
    logger.info("using postgres flight repository");
    return new PostgresFlightRepository({
      connectionString: config.database.url,
      poolMax: config.database.poolMax,
      ssl: config.database.ssl,
    });
  }

  logger.info("using json flight repository", { dataFile: config.flights.dataFile });
  return new JsonFlightRepository({
    dataFile: config.flights.dataFile,
    rollDates: config.flights.rollDates,
  });
}
