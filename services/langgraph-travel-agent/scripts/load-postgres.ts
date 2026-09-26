/**
 * Loads `data/flights.json` into PostgreSQL so the service can run with
 * FLIGHT_REPOSITORY=postgres.
 *
 *   psql "$DATABASE_URL" -f db/schema.sql
 *   DATABASE_URL=postgresql://... npm run load:postgres
 *
 * Safe to re-run: every insert is an upsert.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import type { Airline, FlightOffer } from "../src/domain/types.js";
import type { FlightDataset } from "../src/repositories/JsonFlightRepository.js";

const BATCH_SIZE = 500;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set");
  }

  const dataFile = resolve(process.cwd(), process.env.FLIGHTS_DATA_FILE ?? "data/flights.json");
  const dataset = JSON.parse(await readFile(dataFile, "utf8")) as FlightDataset & {
    airlines: Airline[];
  };

  const pool = new pg.Pool({ connectionString, max: 4 });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const airport of dataset.airports) {
      await client.query(
        `INSERT INTO airports (iata, name, city, country, time_zone)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (iata) DO UPDATE SET name = EXCLUDED.name`,
        [airport.iata, airport.name, airport.city, airport.country, airport.timeZone],
      );
    }

    for (const airline of dataset.airlines ?? []) {
      await client.query(
        `INSERT INTO airlines (iata, name) VALUES ($1, $2)
         ON CONFLICT (iata) DO UPDATE SET name = EXCLUDED.name`,
        [airline.iata, airline.name],
      );
    }

    let inserted = 0;
    for (const offer of dataset.offers) {
      await insertOffer(client, offer);
      inserted += 1;
      if (inserted % BATCH_SIZE === 0) {
        console.log(`  ...${inserted}/${dataset.offers.length} offers`);
      }
    }

    await client.query("COMMIT");
    console.log(`Loaded ${inserted} offers from ${dataFile}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function insertOffer(client: pg.PoolClient, offer: FlightOffer): Promise<void> {
  await client.query(
    `INSERT INTO flight_offers
       (id, owner_iata, cabin_class, total_amount, total_currency,
        seats_available, refundable, baggage_included, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       total_amount = EXCLUDED.total_amount,
       seats_available = EXCLUDED.seats_available`,
    [
      offer.id,
      offer.owner.iata,
      offer.cabinClass,
      offer.totalAmount,
      offer.totalCurrency,
      offer.seatsAvailable,
      offer.refundable,
      offer.baggageIncluded,
      offer.expiresAt,
    ],
  );

  for (const [slicePosition, slice] of offer.slices.entries()) {
    await client.query(
      `INSERT INTO flight_slices
         (id, offer_id, position, origin, destination, departing_at, arriving_at, duration_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [
        slice.id,
        offer.id,
        slicePosition,
        slice.origin,
        slice.destination,
        slice.departingAt,
        slice.arrivingAt,
        slice.durationMinutes,
      ],
    );

    for (const [segmentPosition, segment] of slice.segments.entries()) {
      await client.query(
        `INSERT INTO flight_segments
           (id, slice_id, position, carrier_iata, flight_number, aircraft,
            origin, destination, departing_at, arriving_at, duration_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          segment.id,
          slice.id,
          segmentPosition,
          segment.marketingCarrier.iata,
          segment.flightNumber,
          segment.aircraft,
          segment.origin,
          segment.destination,
          segment.departingAt,
          segment.arrivingAt,
          segment.durationMinutes,
        ],
      );
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
