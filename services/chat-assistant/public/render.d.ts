// Type declarations for the browser rendering module, so the test suite gets
// real types without compiling the browser bundle.
export interface FlightSegmentLike {
  flightNumber?: string;
}

export interface FlightSliceLike {
  origin?: string;
  destination?: string;
  departingAt?: string;
  arrivingAt?: string;
  durationMinutes?: number;
  segments?: FlightSegmentLike[];
}

export interface FlightOfferLike {
  owner?: { name?: string };
  cabinClass?: string;
  totalAmount?: string;
  totalCurrency?: string;
  slices?: FlightSliceLike[];
}

export interface SourceLike {
  title?: string;
  link?: string;
  source?: string;
}

export function escapeHtml(value: unknown): string;
export function renderMarkdown(markdown: string | undefined | null): string;
export function timeOf(timestamp: unknown): string;
export function dateOf(timestamp: unknown): string;
export function durationOf(minutes: number | undefined | null): string;
export function renderFlightCards(
  title: string,
  offers: FlightOfferLike[] | undefined | null,
): string;
export function renderSources(sources: SourceLike[] | undefined | null): string;
