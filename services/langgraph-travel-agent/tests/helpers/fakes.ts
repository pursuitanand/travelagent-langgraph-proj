import type {
  Airport,
  FlightOffer,
  FlightSearchQuery,
  FlightSearchResult,
  WebSearchResponse,
} from "../../src/domain/types.js";
import type { FlightRepository } from "../../src/repositories/FlightRepository.js";
import type { WebSearchService } from "../../src/services/WebSearchService.js";

export function makeOffer(overrides: Partial<FlightOffer> = {}): FlightOffer {
  const base: FlightOffer = {
    id: "off_FAKE0001",
    owner: { iata: "BA", name: "British Airways" },
    cabinClass: "economy",
    totalAmount: "500.00",
    totalCurrency: "USD",
    seatsAvailable: 5,
    refundable: false,
    baggageIncluded: 1,
    expiresAt: "2026-10-19T00:00:00.000Z",
    slices: [
      {
        id: "sli_FAKE0001",
        origin: "LHR",
        destination: "NRT",
        departingAt: "2026-10-20T09:00:00+01:00",
        arrivingAt: "2026-10-21T06:00:00+09:00",
        durationMinutes: 720,
        segments: [
          {
            id: "seg_FAKE0001",
            marketingCarrier: { iata: "BA", name: "British Airways" },
            flightNumber: "BA005",
            aircraft: "Boeing 787-9",
            origin: "LHR",
            destination: "NRT",
            departingAt: "2026-10-20T09:00:00+01:00",
            arrivingAt: "2026-10-21T06:00:00+09:00",
            durationMinutes: 720,
          },
        ],
      },
    ],
  };
  return { ...base, ...overrides };
}

export interface FakeFlightRepositoryOptions {
  offers?: FlightOffer[];
  failWith?: Error;
  usedDateFlexibility?: boolean;
}

/** In-memory `FlightRepository` that records the queries it received. */
export class FakeFlightRepository implements FlightRepository {
  readonly name = "fake";
  readonly queries: FlightSearchQuery[] = [];

  constructor(private readonly options: FakeFlightRepositoryOptions = {}) {}

  async init(): Promise<void> {}

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: !this.options.failWith, detail: "fake repository" };
  }

  async search(query: FlightSearchQuery): Promise<FlightSearchResult> {
    this.queries.push(query);
    if (this.options.failWith) throw this.options.failWith;
    const offers = this.options.offers ?? [];
    return {
      offers,
      usedDateFlexibility: this.options.usedDateFlexibility ?? false,
      matchedDates: offers.map((o) => (o.slices[0]?.departingAt ?? "").slice(0, 10)),
    };
  }

  async getOfferById(id: string): Promise<FlightOffer | null> {
    return (this.options.offers ?? []).find((offer) => offer.id === id) ?? null;
  }

  async listAirports(): Promise<Airport[]> {
    return [];
  }

  async close(): Promise<void> {}
}

export interface FakeWebSearchOptions {
  enabled?: boolean;
  response?: WebSearchResponse;
  failWith?: Error;
}

export class FakeWebSearchService implements WebSearchService {
  readonly name = "fake";
  readonly queries: string[] = [];

  constructor(private readonly options: FakeWebSearchOptions = {}) {}

  get enabled(): boolean {
    return this.options.enabled ?? true;
  }

  async search(query: string): Promise<WebSearchResponse> {
    this.queries.push(query);
    if (this.options.failWith) throw this.options.failWith;
    return (
      this.options.response ?? {
        query,
        provider: this.name,
        results: [
          {
            title: "Tokyo travel guide",
            link: "https://example.com/tokyo",
            snippet: "What to see in Tokyo.",
            position: 1,
            source: "example.com",
          },
        ],
        answerBox: "October is one of the best months to visit Tokyo.",
      }
    );
  }
}
