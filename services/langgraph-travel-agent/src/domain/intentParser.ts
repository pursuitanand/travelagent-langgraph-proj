import { PLACE_TERMS, resolveAirport } from "./airports.js";
import type { Airport, CabinClass, TravelIntent } from "./types.js";

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Topic keyword -> the phrasing used when building the web-search query. */
const TOPIC_KEYWORDS: Array<{ pattern: RegExp; topic: string }> = [
  { pattern: /\b(visas?|entry requirements?|passports?)\b/, topic: "visa requirements" },
  { pattern: /\b(weather|climate|rainfall|temperatures?|monsoon)\b/, topic: "weather" },
  { pattern: /\b(events?|festivals?|concerts?|conferences?)\b/, topic: "events" },
  { pattern: /\b(hotels?|accommodation|where to stay|airbnb)\b/, topic: "where to stay" },
  { pattern: /\b(restaurants?|food|cuisine|dining|where to eat)\b/, topic: "food and restaurants" },
  { pattern: /\b(things to do|attractions?|sightseeing|itinerary|museums?|what to see)\b/, topic: "things to do" },
  { pattern: /\b(safe|safety|crime)\b/, topic: "safety advice" },
  { pattern: /\b(public transport|metro|subway|taxis?|getting around)\b/, topic: "getting around" },
  { pattern: /\b(currency|tipping|cash machines?)\b/, topic: "money and tipping" },
];

interface PlaceMatch {
  airport: Airport;
  start: number;
  end: number;
}

interface DateMatch {
  iso: string;
  start: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function startOfDayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Picks the next occurrence of month/day that is not in the past. */
function resolveYear(month: number, day: number, now: Date, explicitYear?: number): string {
  if (explicitYear) return toIsoDate(explicitYear, month, day);
  const today = startOfDayUtc(now);
  const thisYear = new Date(Date.UTC(today.getUTCFullYear(), month - 1, day));
  if (thisYear.getTime() >= today.getTime()) return isoOf(thisYear);
  return isoOf(new Date(Date.UTC(today.getUTCFullYear() + 1, month - 1, day)));
}

// ---------------------------------------------------------------------------
// places
// ---------------------------------------------------------------------------

function findPlaces(message: string): PlaceMatch[] {
  const lower = message.toLowerCase();
  const claimed: Array<[number, number]> = [];
  const matches: PlaceMatch[] = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  // Longest terms first, so "new york city" wins over "new york".
  for (const term of PLACE_TERMS) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "g");
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(lower)) !== null) {
      const start = hit.index;
      const end = start + hit[0].length;
      if (overlaps(start, end)) continue;
      const airport = resolveAirport(term);
      if (!airport) continue;
      claimed.push([start, end]);
      matches.push({ airport, start, end });
    }
  }

  // Bare IATA codes, matched case-sensitively so ordinary words are not hits.
  const iataPattern = /\b[A-Z]{3}\b/g;
  let iataHit: RegExpExecArray | null;
  while ((iataHit = iataPattern.exec(message)) !== null) {
    const start = iataHit.index;
    const end = start + 3;
    if (overlaps(start, end)) continue;
    const airport = resolveAirport(iataHit[0]);
    if (!airport) continue;
    claimed.push([start, end]);
    matches.push({ airport, start, end });
  }

  return matches.sort((a, b) => a.start - b.start);
}

const ORIGIN_CUES = /\b(from|out of|departing|leaving|starting in)\s*$/i;
const DESTINATION_CUES = /\b(to|into|towards|visit|visiting|see|explore|holiday in|trip to|fly to)\s*$/i;

function assignRoles(
  message: string,
  places: PlaceMatch[],
): { origin: Airport | null; destination: Airport | null } {
  let origin: Airport | null = null;
  let destination: Airport | null = null;

  for (const place of places) {
    const prefix = message.slice(Math.max(0, place.start - 18), place.start);
    if (!origin && ORIGIN_CUES.test(prefix)) {
      origin = place.airport;
      continue;
    }
    if (!destination && DESTINATION_CUES.test(prefix)) {
      destination = place.airport;
    }
  }

  // No cues (e.g. "LHR JFK next tuesday"): fall back to written order.
  const unassigned = places.filter(
    (p) => p.airport !== origin && p.airport !== destination,
  );
  if (!origin && !destination && unassigned.length >= 2) {
    origin = unassigned[0]?.airport ?? null;
    destination = unassigned[1]?.airport ?? null;
  } else if (!destination && unassigned.length >= 1) {
    destination = unassigned[0]?.airport ?? null;
  } else if (!origin && unassigned.length >= 1) {
    origin = unassigned[0]?.airport ?? null;
  }

  if (origin && destination && origin.iata === destination.iata) {
    destination = null;
  }
  return { origin, destination };
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

function findDates(message: string, now: Date): DateMatch[] {
  const lower = message.toLowerCase();
  const found: DateMatch[] = [];
  const today = startOfDayUtc(now);

  const push = (iso: string, start: number): void => {
    if (!found.some((d) => d.iso === iso)) found.push({ iso, start });
  };

  // 2026-05-12
  for (const hit of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(`${hit[1]}-${hit[2]}-${hit[3]}`, hit.index ?? 0);
  }

  // 12 May / 12th of May / 12 May 2026
  const dayMonth = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/g;
  for (const hit of lower.matchAll(dayMonth)) {
    const month = MONTHS[hit[2] ?? ""];
    const day = Number(hit[1]);
    if (!month || day < 1 || day > 31) continue;
    push(resolveYear(month, day, now, hit[3] ? Number(hit[3]) : undefined), hit.index ?? 0);
  }

  // May 12 / May 12th, 2026
  const monthDay = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/g;
  for (const hit of lower.matchAll(monthDay)) {
    const month = MONTHS[hit[1] ?? ""];
    const day = Number(hit[2]);
    if (!month || day < 1 || day > 31) continue;
    push(resolveYear(month, day, now, hit[3] ? Number(hit[3]) : undefined), hit.index ?? 0);
  }

  // today / tomorrow / the day after tomorrow
  if (/\bthe day after tomorrow\b/.test(lower)) {
    push(isoOf(addDays(today, 2)), lower.indexOf("the day after tomorrow"));
  }
  if (/\btomorrow\b/.test(lower)) push(isoOf(addDays(today, 1)), lower.indexOf("tomorrow"));
  if (/\btoday\b/.test(lower)) push(isoOf(today), lower.indexOf("today"));

  // in 3 days / in two weeks / in a month
  for (const hit of lower.matchAll(/\bin\s+(\d{1,2}|[a-z]+)\s+(day|week|month)s?\b/g)) {
    const raw = hit[1] ?? "";
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (!count) continue;
    const unit = hit[2];
    const days = unit === "week" ? count * 7 : unit === "month" ? count * 30 : count;
    push(isoOf(addDays(today, days)), hit.index ?? 0);
  }

  // next friday / on monday / this saturday
  for (const hit of lower.matchAll(/\b(next|this|on|coming)?\s*([a-z]+day)\b/g)) {
    const weekday = WEEKDAYS[hit[2] ?? ""];
    if (weekday === undefined) continue;
    const delta = (weekday - today.getUTCDay() + 7) % 7;
    const offset = delta === 0 || hit[1] === "next" ? delta + 7 : delta;
    push(isoOf(addDays(today, offset)), hit.index ?? 0);
  }

  // this weekend -> the coming Saturday
  if (/\b(this |next )?weekend\b/.test(lower)) {
    const delta = (6 - today.getUTCDay() + 7) % 7 || 7;
    push(isoOf(addDays(today, delta)), lower.indexOf("weekend"));
  }

  return found.sort((a, b) => a.start - b.start);
}

/** "for 5 nights", "for a week", "10 day trip" -> number of days. */
function findTripLengthDays(message: string): number | null {
  const lower = message.toLowerCase();
  const patterns = [
    /\bfor\s+(\d{1,2}|[a-z]+)\s+(night|day|week)s?\b/,
    /\b(\d{1,2}|[a-z]+)[-\s](night|day|week)\s+(?:trip|stay|holiday|break)\b/,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(lower);
    if (!hit) continue;
    const raw = hit[1] ?? "";
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (!count) continue;
    return hit[2] === "week" ? count * 7 : count;
  }
  return null;
}

// ---------------------------------------------------------------------------
// other slots
// ---------------------------------------------------------------------------

function findPassengers(message: string): number {
  const lower = message.toLowerCase();
  const hit =
    /\b(\d{1,2}|[a-z]+)\s+(?:adults?|passengers?|people|persons?|travell?ers?|of us)\b/.exec(lower);
  if (hit) {
    const raw = hit[1] ?? "";
    const count = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (count && count > 0 && count <= 9) return count;
  }
  if (/\b(solo|just me|by myself|alone)\b/.test(lower)) return 1;
  if (/\bmy (wife|husband|partner)\b|\bcouple\b/.test(lower)) return 2;
  return 1;
}

function findCabin(message: string): CabinClass | null {
  const lower = message.toLowerCase();
  if (/\bfirst class\b/.test(lower)) return "first";
  if (/\bbusiness( class)?\b/.test(lower)) return "business";
  if (/\bpremium economy\b/.test(lower)) return "premium_economy";
  if (/\b(economy|coach|cheap seats)\b/.test(lower)) return "economy";
  return null;
}

function findMaxPrice(message: string): number | null {
  const lower = message.toLowerCase();
  const patterns = [
    /\b(?:under|below|less than|max(?:imum)?|budget of|up to|no more than)\s*(?:\$|usd\s*)?(\d{2,6})\b/,
    /\b(?:\$|usd\s*)(\d{2,6})\s*(?:budget|max|or less)\b/,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(lower);
    if (hit?.[1]) return Number(hit[1]);
  }
  return null;
}

function findTopics(message: string): string[] {
  const lower = message.toLowerCase();
  const topics = TOPIC_KEYWORDS.filter((entry) => entry.pattern.test(lower)).map(
    (entry) => entry.topic,
  );
  return [...new Set(topics)];
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface ParseOptions {
  now?: Date;
  /** Earlier turns, used to carry forward an already-known route. */
  previous?: TravelIntent | null;
}

/**
 * Rule-based slot filling over the user's message.
 *
 * Deterministic on purpose: the flight search must not depend on an LLM call
 * (no API key needed, no latency, fully unit-testable). The LLM is used only
 * to write the final reply.
 */
export function parseTravelRequest(message: string, options: ParseOptions = {}): TravelIntent {
  const now = options.now ?? new Date();
  const previous = options.previous ?? null;

  const places = findPlaces(message);
  const roles = assignRoles(message, places);
  const dates = findDates(message, now);
  const tripLength = findTripLengthDays(message);

  // Follow-ups such as "what about business class?" inherit the known route.
  const origin = roles.origin ?? (roles.destination ? null : previous?.origin) ?? previous?.origin ?? null;
  const destination = roles.destination ?? previous?.destination ?? null;

  const departureDate = dates[0]?.iso ?? previous?.departureDate ?? null;
  let returnDate = dates[1]?.iso ?? null;
  if (!returnDate && departureDate && tripLength !== null) {
    returnDate = isoOf(addDays(new Date(`${departureDate}T00:00:00Z`), tripLength));
  }
  if (/\b(one way|one-way|single|no return)\b/i.test(message)) {
    returnDate = null;
  }

  const passengers = findPassengers(message);
  const cabinClass = findCabin(message) ?? previous?.cabinClass ?? null;
  const maxPrice = findMaxPrice(message) ?? previous?.maxPrice ?? null;

  return {
    origin,
    destination,
    departureDate,
    returnDate,
    passengers: passengers > 1 ? passengers : (previous?.passengers ?? passengers),
    cabinClass,
    maxPrice,
    topics: findTopics(message),
    searchable: Boolean(origin && destination),
    rawMessage: message.trim(),
  };
}
