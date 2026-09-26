import type {
  Airline,
  Airport,
  CabinClass,
  FlightOffer,
  FlightSegment,
  FlightSlice,
} from "../domain/types.js";
import type {
  DuffelAirline,
  DuffelAirport,
  DuffelOffer,
  DuffelSegment,
  DuffelSlice,
} from "./duffelTypes.js";

/**
 * Pure translation from Duffel's wire format to the local domain model.
 *
 * Kept free of I/O so the mapping rules are unit-tested without a live API
 * token, exactly like `buildFlightSearchSql()` for the Postgres driver.
 */

const CABIN_CLASSES: readonly CabinClass[] = [
  "economy",
  "premium_economy",
  "business",
  "first",
];

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parses an ISO-8601 duration ("PT11H50M", "P1DT2H30M") into whole minutes.
 * Returns null for anything unparseable so callers can fall back.
 */
export function parseIso8601DurationMinutes(duration: string | null | undefined): number | null {
  if (typeof duration !== "string") return null;
  const match = ISO_DURATION.exec(duration.trim());
  if (!match) return null;

  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  // Years and months are not meaningful for a flight; treating them as zero is
  // safer than guessing a calendar length.
  if (years !== undefined || months !== undefined) return null;

  const total =
    Number(weeks ?? 0) * 7 * 24 * 60 +
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Math.round(Number(seconds ?? 0) / 60);

  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Minutes between two Duffel timestamps; used when `duration` is absent. */
function minutesBetween(from: string | null | undefined, to: string | null | undefined): number {
  if (!from || !to) return 0;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 60_000));
}

function mapAirline(airline: DuffelAirline | null | undefined): Airline {
  return {
    iata: airline?.iata_code ?? "",
    name: airline?.name ?? airline?.iata_code ?? "Unknown airline",
  };
}

function airportCode(airport: DuffelAirport | null | undefined): string {
  return airport?.iata_code ?? "";
}

export function mapDuffelAirport(airport: DuffelAirport): Airport {
  return {
    iata: airport.iata_code ?? "",
    name: airport.name ?? "",
    city: airport.city_name ?? airport.city?.name ?? "",
    // Duffel exposes a 2-letter country code rather than a country name.
    country: airport.iata_country_code ?? "",
    timeZone: airport.time_zone ?? "UTC",
  };
}

function normaliseCabin(value: string | null | undefined): CabinClass | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return CABIN_CLASSES.find((cabin) => cabin === candidate) ?? null;
}

/**
 * Duffel reports the cabin per segment per passenger. An offer can in theory
 * mix cabins across legs; the summary takes the first segment's cabin, which
 * is what a traveller reads as "the" cabin of the offer.
 */
function offerCabin(slices: DuffelSlice[], fallback: CabinClass): CabinClass {
  for (const slice of slices) {
    for (const segment of slice.segments ?? []) {
      for (const passenger of segment.passengers ?? []) {
        const cabin = normaliseCabin(passenger.cabin_class);
        if (cabin) return cabin;
      }
    }
  }
  return fallback;
}

/** Checked bags included for the first passenger on the first segment. */
function checkedBaggage(slices: DuffelSlice[]): number {
  const firstSegment = slices[0]?.segments?.[0];
  const firstPassenger = firstSegment?.passengers?.[0];
  if (!firstPassenger?.baggages) return 0;

  return firstPassenger.baggages
    .filter((bag) => bag.type === "checked")
    .reduce((total, bag) => total + (bag.quantity ?? 0), 0);
}

function mapSegment(segment: DuffelSegment, index: number, offerId: string): FlightSegment {
  const carrier = mapAirline(segment.marketing_carrier);
  const number = segment.marketing_carrier_flight_number ?? "";

  return {
    id: segment.id ?? `${offerId}_seg_${index + 1}`,
    marketingCarrier: carrier,
    // Duffel returns the bare number ("117"); the domain uses "BA117".
    flightNumber: number === "" ? carrier.iata : `${carrier.iata}${number}`,
    aircraft: segment.aircraft?.name ?? segment.aircraft?.iata_code ?? "Unknown aircraft",
    origin: airportCode(segment.origin),
    destination: airportCode(segment.destination),
    departingAt: segment.departing_at ?? "",
    arrivingAt: segment.arriving_at ?? "",
    durationMinutes:
      parseIso8601DurationMinutes(segment.duration) ??
      minutesBetween(segment.departing_at, segment.arriving_at),
  };
}

function mapSlice(slice: DuffelSlice, index: number, offerId: string): FlightSlice {
  const segments = (slice.segments ?? []).map((segment, i) => mapSegment(segment, i, offerId));
  const first = segments[0];
  const last = segments[segments.length - 1];

  const departingAt = first?.departingAt ?? "";
  const arrivingAt = last?.arrivingAt ?? "";

  return {
    id: slice.id ?? `${offerId}_sli_${index + 1}`,
    origin: airportCode(slice.origin) || (first?.origin ?? ""),
    destination: airportCode(slice.destination) || (last?.destination ?? ""),
    departingAt,
    arrivingAt,
    durationMinutes:
      parseIso8601DurationMinutes(slice.duration) ?? minutesBetween(departingAt, arrivingAt),
    segments,
  };
}

export interface MapOfferOptions {
  /**
   * Duffel prices an offer for the passengers in the offer request and does
   * not publish remaining inventory, so the domain's `seatsAvailable` is set
   * to the number of travellers the offer was quoted for.
   */
  passengers: number;
  /** Used when no segment reports a cabin class. */
  fallbackCabin?: CabinClass;
}

/**
 * Maps one Duffel offer onto the domain `FlightOffer`.
 *
 * Note on timestamps: Duffel returns local times with no UTC offset
 * ("2026-10-20T09:00:00"), i.e. the clock time at the airport. The domain
 * treats these as display strings, so they flow through unchanged — the
 * seeded JSON dataset carries explicit offsets instead, and both render
 * identically.
 */
export function mapDuffelOffer(offer: DuffelOffer, options: MapOfferOptions): FlightOffer {
  const slices = (offer.slices ?? []).map((slice, index) => mapSlice(slice, index, offer.id));
  const conditions = offer.conditions?.refund_before_departure;

  return {
    id: offer.id,
    owner: mapAirline(offer.owner),
    cabinClass: offerCabin(offer.slices ?? [], options.fallbackCabin ?? "economy"),
    totalAmount: offer.total_amount ?? "0.00",
    totalCurrency: offer.total_currency ?? "USD",
    seatsAvailable: Math.max(1, options.passengers),
    refundable: conditions?.allowed === true,
    baggageIncluded: checkedBaggage(offer.slices ?? []),
    expiresAt: offer.expires_at ?? "",
    slices,
  };
}

/** Offers whose quote has already lapsed must never be shown as bookable. */
export function isOfferExpired(offer: FlightOffer, now: Date): boolean {
  if (offer.expiresAt === "") return false;
  const expiry = Date.parse(offer.expiresAt);
  return !Number.isNaN(expiry) && expiry <= now.getTime();
}
