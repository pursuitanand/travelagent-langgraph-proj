import type { FlightSearchQuery } from "../domain/types.js";
import { DEFAULT_SEARCH_LIMIT } from "./FlightRepository.js";

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export interface DateWindow {
  /** Inclusive ISO date. */
  from: string;
  /** Inclusive ISO date. */
  to: string;
}

/**
 * Builds the offer-search statement against the `flight_offer_json` view
 * (see `db/schema.sql`).
 *
 * Kept as a pure function so the filter/parameter logic is unit-testable
 * without a live database.
 */
export function buildFlightSearchSql(
  query: FlightSearchQuery,
  window?: DateWindow,
): SqlStatement {
  const values: unknown[] = [];
  const conditions: string[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  conditions.push(`origin = ${param(query.origin.toUpperCase())}`);
  conditions.push(`destination = ${param(query.destination.toUpperCase())}`);
  conditions.push(`seats_available >= ${param(query.passengers ?? 1)}`);

  if (window) {
    conditions.push(`departing_on >= ${param(window.from)}::date`);
    conditions.push(`departing_on <= ${param(window.to)}::date`);
  }
  if (query.cabinClass) {
    conditions.push(`cabin_class = ${param(query.cabinClass)}`);
  }
  if (query.maxPrice !== undefined) {
    conditions.push(`total_amount <= ${param(query.maxPrice)}`);
  }
  if (query.currency) {
    conditions.push(`total_currency = ${param(query.currency.toUpperCase())}`);
  }

  const limit = param(query.limit ?? DEFAULT_SEARCH_LIMIT);

  const text = [
    "SELECT payload",
    "FROM flight_offer_json",
    `WHERE ${conditions.join("\n  AND ")}`,
    "ORDER BY total_amount ASC, departing_at ASC",
    `LIMIT ${limit}`,
  ].join("\n");

  return { text, values };
}
