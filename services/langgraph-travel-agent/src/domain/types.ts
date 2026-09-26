/**
 * Domain model for the travel agent.
 *
 * The flight shapes deliberately mirror the vocabulary used by Duffel
 * (https://duffel.com) - offers, slices, segments, an owning airline and a
 * total amount - so that swapping the seeded JSON dataset for the live Duffel
 * API (or a Postgres mirror of it) is a repository-level change only.
 */

export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export interface Airport {
  /** IATA code, e.g. "LHR". */
  iata: string;
  name: string;
  city: string;
  country: string;
  timeZone: string;
}

export interface Airline {
  /** IATA airline designator, e.g. "BA". */
  iata: string;
  name: string;
}

export interface FlightSegment {
  id: string;
  marketingCarrier: Airline;
  flightNumber: string;
  aircraft: string;
  origin: string;
  destination: string;
  /** ISO-8601 local departure timestamp with offset. */
  departingAt: string;
  arrivingAt: string;
  durationMinutes: number;
}

export interface FlightSlice {
  id: string;
  origin: string;
  destination: string;
  departingAt: string;
  arrivingAt: string;
  durationMinutes: number;
  segments: FlightSegment[];
}

export interface FlightOffer {
  /** Duffel-style offer id, e.g. "off_0000AgZxK12". */
  id: string;
  owner: Airline;
  cabinClass: CabinClass;
  /** Decimal string, as returned by Duffel. */
  totalAmount: string;
  totalCurrency: string;
  /** Maximum passengers bookable on this offer. */
  seatsAvailable: number;
  refundable: boolean;
  baggageIncluded: number;
  expiresAt: string;
  slices: FlightSlice[];
}

export interface FlightSearchQuery {
  origin: string;
  destination: string;
  /** ISO date (YYYY-MM-DD). When omitted, any date matches. */
  departureDate?: string;
  passengers?: number;
  cabinClass?: CabinClass;
  maxPrice?: number;
  currency?: string;
  limit?: number;
  /** Widen the date filter by +/- N days when no exact match exists. */
  dateFlexibilityDays?: number;
}

export interface FlightSearchResult {
  offers: FlightOffer[];
  /** True when results come from a nearby date rather than the requested one. */
  usedDateFlexibility: boolean;
  matchedDates: string[];
}

/** Structured travel request extracted from the user's free-text message. */
export interface TravelIntent {
  origin: Airport | null;
  destination: Airport | null;
  departureDate: string | null;
  returnDate: string | null;
  passengers: number;
  cabinClass: CabinClass | null;
  maxPrice: number | null;
  /** Non-flight topics worth researching on the web, e.g. "visa", "weather". */
  topics: string[];
  /** True when the message contains enough detail to run a flight search. */
  searchable: boolean;
  rawMessage: string;
}

export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  source?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  answerBox?: string;
  provider: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Everything `combineResults` hands to the response generator. */
export interface TravelBrief {
  intent: TravelIntent;
  outbound: FlightOffer[];
  inbound: FlightOffer[];
  cheapestOutbound: FlightOffer | null;
  fastestOutbound: FlightOffer | null;
  priceRange: { min: number; max: number; currency: string } | null;
  webResults: WebSearchResult[];
  webAnswer: string | null;
  notes: string[];
}
