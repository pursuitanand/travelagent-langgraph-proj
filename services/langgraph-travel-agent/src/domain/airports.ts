import type { Airport } from "./types.js";

/**
 * Small curated airport catalogue. It backs both the seeded flight dataset and
 * the natural-language parser, so any city the parser understands is
 * guaranteed to have flights in the dataset.
 */
export const AIRPORTS: readonly Airport[] = [
  { iata: "LHR", name: "Heathrow", city: "London", country: "United Kingdom", timeZone: "Europe/London" },
  { iata: "CDG", name: "Charles de Gaulle", city: "Paris", country: "France", timeZone: "Europe/Paris" },
  { iata: "AMS", name: "Schiphol", city: "Amsterdam", country: "Netherlands", timeZone: "Europe/Amsterdam" },
  { iata: "BCN", name: "El Prat", city: "Barcelona", country: "Spain", timeZone: "Europe/Madrid" },
  { iata: "BER", name: "Brandenburg", city: "Berlin", country: "Germany", timeZone: "Europe/Berlin" },
  { iata: "IST", name: "Istanbul Airport", city: "Istanbul", country: "Turkey", timeZone: "Europe/Istanbul" },
  { iata: "JFK", name: "John F. Kennedy", city: "New York", country: "United States", timeZone: "America/New_York" },
  { iata: "SFO", name: "San Francisco Intl", city: "San Francisco", country: "United States", timeZone: "America/Los_Angeles" },
  { iata: "LAX", name: "Los Angeles Intl", city: "Los Angeles", country: "United States", timeZone: "America/Los_Angeles" },
  { iata: "DXB", name: "Dubai Intl", city: "Dubai", country: "United Arab Emirates", timeZone: "Asia/Dubai" },
  { iata: "DEL", name: "Indira Gandhi Intl", city: "Delhi", country: "India", timeZone: "Asia/Kolkata" },
  { iata: "BOM", name: "Chhatrapati Shivaji Maharaj Intl", city: "Mumbai", country: "India", timeZone: "Asia/Kolkata" },
  { iata: "SIN", name: "Changi", city: "Singapore", country: "Singapore", timeZone: "Asia/Singapore" },
  { iata: "HKG", name: "Hong Kong Intl", city: "Hong Kong", country: "Hong Kong", timeZone: "Asia/Hong_Kong" },
  { iata: "NRT", name: "Narita", city: "Tokyo", country: "Japan", timeZone: "Asia/Tokyo" },
  { iata: "SYD", name: "Kingsford Smith", city: "Sydney", country: "Australia", timeZone: "Australia/Sydney" },
];

const BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

/** Spoken/written names that should resolve to an airport, lower-cased. */
const ALIASES: Record<string, string> = {
  london: "LHR",
  heathrow: "LHR",
  paris: "CDG",
  amsterdam: "AMS",
  barcelona: "BCN",
  berlin: "BER",
  istanbul: "IST",
  "new york": "JFK",
  "new york city": "JFK",
  nyc: "JFK",
  manhattan: "JFK",
  "san francisco": "SFO",
  "the bay area": "SFO",
  "los angeles": "LAX",
  la: "LAX",
  dubai: "DXB",
  delhi: "DEL",
  "new delhi": "DEL",
  mumbai: "BOM",
  bombay: "BOM",
  singapore: "SIN",
  "hong kong": "HKG",
  tokyo: "NRT",
  narita: "NRT",
  sydney: "SYD",
};

export function findAirportByIata(code: string): Airport | null {
  return BY_IATA.get(code.trim().toUpperCase()) ?? null;
}

/** Resolves an IATA code, a city name, or a known alias to an airport. */
export function resolveAirport(term: string): Airport | null {
  const cleaned = term.trim().toLowerCase();
  if (cleaned === "") return null;

  if (/^[a-z]{3}$/.test(cleaned)) {
    const byCode = findAirportByIata(cleaned);
    if (byCode) return byCode;
  }
  const aliased = ALIASES[cleaned];
  if (aliased) return findAirportByIata(aliased);

  return AIRPORTS.find((a) => a.city.toLowerCase() === cleaned) ?? null;
}

/**
 * All searchable place names, longest first, so that greedy matching prefers
 * "new york city" over "new york".
 */
export const PLACE_TERMS: readonly string[] = [
  ...new Set([...Object.keys(ALIASES), ...AIRPORTS.map((a) => a.city.toLowerCase())]),
].sort((a, b) => b.length - a.length);
