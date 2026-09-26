/**
 * Generates `data/flights.json` - a deterministic, Duffel-shaped set of
 * one-way flight offers used by JsonFlightRepository.
 *
 *   npm run seed:flights
 *   npm run seed:flights -- --days 60 --seed 7
 *
 * The output is committed so the demo needs no external flight API.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AIRPORTS, findAirportByIata } from "../src/domain/airports.js";
import type {
  Airline,
  CabinClass,
  FlightOffer,
  FlightSegment,
  FlightSlice,
} from "../src/domain/types.js";

interface RouteSpec {
  from: string;
  to: string;
  /** Non-stop block time in minutes. */
  minutes: number;
  /** Base economy fare in USD for a one-way ticket. */
  basePrice: number;
  carriers: string[];
  /** IATA code of a plausible connecting hub. */
  via?: string;
}

const AIRLINES: Record<string, Airline> = {
  BA: { iata: "BA", name: "British Airways" },
  VS: { iata: "VS", name: "Virgin Atlantic" },
  AA: { iata: "AA", name: "American Airlines" },
  DL: { iata: "DL", name: "Delta Air Lines" },
  UA: { iata: "UA", name: "United Airlines" },
  AF: { iata: "AF", name: "Air France" },
  KL: { iata: "KL", name: "KLM" },
  LH: { iata: "LH", name: "Lufthansa" },
  IB: { iata: "IB", name: "Iberia" },
  TK: { iata: "TK", name: "Turkish Airlines" },
  EK: { iata: "EK", name: "Emirates" },
  QR: { iata: "QR", name: "Qatar Airways" },
  SQ: { iata: "SQ", name: "Singapore Airlines" },
  CX: { iata: "CX", name: "Cathay Pacific" },
  NH: { iata: "NH", name: "All Nippon Airways" },
  JL: { iata: "JL", name: "Japan Airlines" },
  AI: { iata: "AI", name: "Air India" },
  QF: { iata: "QF", name: "Qantas" },
};

const WIDEBODY = ["Boeing 787-9", "Boeing 777-300ER", "Airbus A350-900", "Airbus A330-300"];
const NARROWBODY = ["Airbus A320neo", "Airbus A321neo", "Boeing 737 MAX 8", "Embraer E195-E2"];

/** Long sectors get widebodies, short hops get narrowbodies. */
function fleetFor(minutes: number): readonly string[] {
  return minutes >= 300 ? WIDEBODY : NARROWBODY;
}

/** Each route is generated in both directions. */
const ROUTES: RouteSpec[] = [
  { from: "LHR", to: "JFK", minutes: 475, basePrice: 430, carriers: ["BA", "VS", "AA", "DL"] },
  { from: "LHR", to: "CDG", minutes: 80, basePrice: 95, carriers: ["BA", "AF"] },
  { from: "LHR", to: "BCN", minutes: 135, basePrice: 110, carriers: ["BA", "IB"] },
  { from: "LHR", to: "DXB", minutes: 415, basePrice: 390, carriers: ["BA", "EK"] },
  { from: "LHR", to: "SIN", minutes: 815, basePrice: 660, carriers: ["BA", "SQ"] },
  { from: "LHR", to: "BOM", minutes: 530, basePrice: 470, carriers: ["BA", "AI"], via: "DXB" },
  { from: "LHR", to: "DEL", minutes: 520, basePrice: 455, carriers: ["BA", "AI"], via: "IST" },
  { from: "CDG", to: "JFK", minutes: 490, basePrice: 445, carriers: ["AF", "DL"] },
  { from: "CDG", to: "NRT", minutes: 730, basePrice: 690, carriers: ["AF", "JL"] },
  { from: "AMS", to: "JFK", minutes: 480, basePrice: 425, carriers: ["KL", "DL"] },
  { from: "AMS", to: "BER", minutes: 85, basePrice: 90, carriers: ["KL", "LH"] },
  { from: "BER", to: "IST", minutes: 185, basePrice: 140, carriers: ["LH", "TK"] },
  { from: "JFK", to: "SFO", minutes: 375, basePrice: 230, carriers: ["UA", "DL", "AA"] },
  { from: "JFK", to: "LAX", minutes: 370, basePrice: 220, carriers: ["UA", "DL", "AA"] },
  { from: "JFK", to: "NRT", minutes: 845, basePrice: 780, carriers: ["NH", "JL", "UA"] },
  { from: "SFO", to: "SIN", minutes: 1020, basePrice: 830, carriers: ["SQ", "UA"] },
  { from: "SFO", to: "HKG", minutes: 900, basePrice: 745, carriers: ["CX", "UA"] },
  { from: "LAX", to: "SYD", minutes: 905, basePrice: 880, carriers: ["QF", "UA"] },
  { from: "DXB", to: "BOM", minutes: 195, basePrice: 175, carriers: ["EK", "AI"] },
  { from: "DXB", to: "SIN", minutes: 440, basePrice: 340, carriers: ["EK", "SQ"] },
  { from: "DEL", to: "BOM", minutes: 135, basePrice: 85, carriers: ["AI"] },
  { from: "DEL", to: "SIN", minutes: 345, basePrice: 300, carriers: ["AI", "SQ"] },
  { from: "SIN", to: "NRT", minutes: 425, basePrice: 395, carriers: ["SQ", "NH"] },
  { from: "SIN", to: "SYD", minutes: 470, basePrice: 430, carriers: ["SQ", "QF"] },
  { from: "HKG", to: "NRT", minutes: 235, basePrice: 260, carriers: ["CX", "JL"] },
  { from: "IST", to: "DXB", minutes: 290, basePrice: 245, carriers: ["TK", "EK"] },
  { from: "IST", to: "JFK", minutes: 665, basePrice: 520, carriers: ["TK", "QR"] },
  { from: "LHR", to: "NRT", minutes: 720, basePrice: 700, carriers: ["BA", "JL", "NH"] },
  { from: "LHR", to: "HKG", minutes: 720, basePrice: 655, carriers: ["BA", "CX"] },
  { from: "LHR", to: "SYD", minutes: 1290, basePrice: 1080, carriers: ["QF", "EK"], via: "DXB" },
  { from: "LHR", to: "AMS", minutes: 75, basePrice: 90, carriers: ["BA", "KL"] },
  { from: "LHR", to: "BER", minutes: 110, basePrice: 105, carriers: ["BA", "LH"] },
  { from: "LHR", to: "IST", minutes: 235, basePrice: 195, carriers: ["BA", "TK"] },
  { from: "CDG", to: "BCN", minutes: 105, basePrice: 95, carriers: ["AF", "IB"] },
  { from: "CDG", to: "DXB", minutes: 400, basePrice: 375, carriers: ["AF", "EK"] },
  { from: "SFO", to: "NRT", minutes: 655, basePrice: 690, carriers: ["UA", "NH", "JL"] },
  { from: "LAX", to: "NRT", minutes: 670, basePrice: 705, carriers: ["UA", "JL"] },
  { from: "DEL", to: "DXB", minutes: 220, basePrice: 190, carriers: ["AI", "EK"] },
  { from: "BOM", to: "SIN", minutes: 335, basePrice: 285, carriers: ["AI", "SQ"] },
  { from: "NRT", to: "SYD", minutes: 585, basePrice: 620, carriers: ["QF", "JL"] },
  { from: "AMS", to: "BCN", minutes: 125, basePrice: 100, carriers: ["KL", "IB"] },
  { from: "AMS", to: "CDG", minutes: 70, basePrice: 85, carriers: ["KL", "AF"] },
  { from: "BER", to: "BCN", minutes: 155, basePrice: 115, carriers: ["LH", "IB"] },
];

const DEPARTURE_SLOTS = [6.25, 8.75, 11.5, 14.25, 17.75, 21.5];

const CABIN_MULTIPLIER: Record<CabinClass, number> = {
  economy: 1,
  premium_economy: 1.6,
  business: 2.9,
  first: 4.6,
};

// --------------------------------------------------------------------------
// deterministic RNG
// --------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// --------------------------------------------------------------------------
// timezone helpers - render a UTC instant as a local ISO string with offset
// --------------------------------------------------------------------------
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const name =
    formatter.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const [, sign, hours, minutes] = match as unknown as [string, string, string, string];
  const total = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -total : total;
}

function offsetSuffix(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Renders a UTC instant as "YYYY-MM-DDTHH:mm:ss+HH:MM" in `timeZone`. */
function toZonedIso(instant: Date, timeZone: string): string {
  const offset = zoneOffsetMinutes(instant, timeZone);
  const shifted = new Date(instant.getTime() + offset * 60_000);
  return `${shifted.toISOString().slice(0, 19)}${offsetSuffix(offset)}`;
}

/** Inverse of `toZonedIso`: a local wall clock in `timeZone` -> UTC instant. */
function zonedWallClockToUtc(
  isoDate: string,
  hours: number,
  minutes: number,
  timeZone: string,
): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, day, hours, minutes);
  const firstGuess = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  return new Date(naive - zoneOffsetMinutes(new Date(firstGuess), timeZone) * 60_000);
}

// --------------------------------------------------------------------------
// generation
// --------------------------------------------------------------------------
function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function offerId(counter: number): string {
  return `off_${counter.toString(36).padStart(8, "0").toUpperCase()}`;
}

function buildSegment(
  id: string,
  carrier: Airline,
  flightNumber: string,
  aircraft: string,
  origin: string,
  destination: string,
  departUtc: Date,
  minutes: number,
): FlightSegment {
  const originTz = findAirportByIata(origin)?.timeZone ?? "UTC";
  const destinationTz = findAirportByIata(destination)?.timeZone ?? "UTC";
  const arriveUtc = new Date(departUtc.getTime() + minutes * 60_000);
  return {
    id,
    marketingCarrier: carrier,
    flightNumber,
    aircraft,
    origin,
    destination,
    departingAt: toZonedIso(departUtc, originTz),
    arrivingAt: toZonedIso(arriveUtc, destinationTz),
    durationMinutes: minutes,
  };
}

function buildOffer(
  random: () => number,
  counter: number,
  route: RouteSpec,
  isoDate: string,
  slotHour: number,
  cabinClass: CabinClass,
  withStop: boolean,
): FlightOffer {
  const carrier = AIRLINES[pick(random, route.carriers)] as Airline;
  const originTz = findAirportByIata(route.from)?.timeZone ?? "UTC";
  const hours = Math.floor(slotHour);
  const minutes = Math.round((slotHour - hours) * 60);
  const departUtc = zonedWallClockToUtc(isoDate, hours, minutes, originTz);

  const segments: FlightSegment[] = [];
  const id = offerId(counter);

  if (withStop && route.via) {
    const legOne = Math.round(route.minutes * 0.55);
    const layover = 55 + Math.floor(random() * 90);
    const legTwo = Math.round(route.minutes * 0.62);
    const connectUtc = new Date(departUtc.getTime() + (legOne + layover) * 60_000);
    segments.push(
      buildSegment(
        `${id}_seg_1`,
        carrier,
        `${carrier.iata}${100 + Math.floor(random() * 880)}`,
        pick(random, fleetFor(legOne)),
        route.from,
        route.via,
        departUtc,
        legOne,
      ),
      buildSegment(
        `${id}_seg_2`,
        carrier,
        `${carrier.iata}${100 + Math.floor(random() * 880)}`,
        pick(random, fleetFor(legTwo)),
        route.via,
        route.to,
        connectUtc,
        legTwo,
      ),
    );
  } else {
    const jitter = Math.floor(random() * 25) - 10;
    segments.push(
      buildSegment(
        `${id}_seg_1`,
        carrier,
        `${carrier.iata}${100 + Math.floor(random() * 880)}`,
        pick(random, fleetFor(route.minutes)),
        route.from,
        route.to,
        departUtc,
        route.minutes + jitter,
      ),
    );
  }

  const first = segments[0] as FlightSegment;
  const last = segments[segments.length - 1] as FlightSegment;
  const totalMinutes = Math.round(
    (Date.parse(last.arrivingAt) - Date.parse(first.departingAt)) / 60_000,
  );

  const slice: FlightSlice = {
    id: `${id}_sli_1`,
    origin: route.from,
    destination: route.to,
    departingAt: first.departingAt,
    arrivingAt: last.arrivingAt,
    durationMinutes: totalMinutes,
    segments,
  };

  // Fares: cabin multiplier, a peak-hour bump, a connection discount and noise.
  const peak = slotHour >= 7 && slotHour <= 10 ? 1.12 : slotHour >= 20 ? 0.92 : 1;
  const stopDiscount = segments.length > 1 ? 0.84 : 1;
  const noise = 0.88 + random() * 0.34;
  const amount = route.basePrice * CABIN_MULTIPLIER[cabinClass] * peak * stopDiscount * noise;

  return {
    id,
    owner: carrier,
    cabinClass,
    totalAmount: (Math.round(amount * 100) / 100).toFixed(2),
    totalCurrency: "USD",
    seatsAvailable: 1 + Math.floor(random() * 8),
    refundable: cabinClass !== "economy" ? random() > 0.25 : random() > 0.8,
    baggageIncluded: cabinClass === "economy" ? (random() > 0.5 ? 1 : 0) : 2,
    expiresAt: new Date(departUtc.getTime() - 24 * 60 * 60_000).toISOString(),
    slices: [slice],
  };
}

function parseArgs(argv: string[]): { days: number; seed: number; baseDate: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) args.set(token.slice(2), argv[i + 1] ?? "");
  }
  const today = new Date();
  return {
    days: Number(args.get("days") ?? 30),
    seed: Number(args.get("seed") ?? 20260925),
    baseDate: args.get("base-date") || today.toISOString().slice(0, 10),
  };
}

function main(): void {
  const { days, seed, baseDate } = parseArgs(process.argv.slice(2));
  const random = mulberry32(seed);
  const offers: FlightOffer[] = [];
  let counter = 1;

  const directedRoutes: RouteSpec[] = ROUTES.flatMap((route) => [
    route,
    { ...route, from: route.to, to: route.from },
  ]);

  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    const date = new Date(`${baseDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    const isoDate = date.toISOString().slice(0, 10);

    for (const route of directedRoutes) {
      const slots = DEPARTURE_SLOTS.filter(() => random() > 0.84);
      const chosen = slots.length > 0 ? slots : [DEPARTURE_SLOTS[2] as number];

      for (const slot of chosen) {
        offers.push(buildOffer(random, counter++, route, isoDate, slot, "economy", false));
        if (random() > 0.7) {
          offers.push(buildOffer(random, counter++, route, isoDate, slot, "business", false));
        }
        if (random() > 0.85) {
          offers.push(
            buildOffer(random, counter++, route, isoDate, slot, "premium_economy", false),
          );
        }
        if (route.via && random() > 0.7) {
          offers.push(buildOffer(random, counter++, route, isoDate, slot, "economy", true));
        }
      }
    }
  }

  const dataset = {
    $comment:
      "Synthetic, Duffel-shaped flight offers for local development. Regenerate with `npm run seed:flights`.",
    generator: "scripts/generate-flights.ts",
    version: 1,
    seed,
    generatedAt: new Date().toISOString(),
    baseDate,
    horizonDays: days,
    defaultCurrency: "USD",
    airports: AIRPORTS,
    airlines: Object.values(AIRLINES),
    offers,
  };

  const outFile = resolve(process.cwd(), "data/flights.json");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${offers.length} offers across ${directedRoutes.length} directed routes and ${days} days -> ${outFile}`,
  );
}

main();
