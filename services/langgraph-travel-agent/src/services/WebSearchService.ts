import type { WebSearchResponse } from "../domain/types.js";

export interface WebSearchOptions {
  maxResults?: number;
  /** Two-letter country bias, e.g. "gb". */
  country?: string;
}

/** Provider-agnostic web search, implemented by `SerperSearchService`. */
export interface WebSearchService {
  readonly name: string;
  /** False when no API key is configured; callers should skip gracefully. */
  readonly enabled: boolean;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse>;
}

/**
 * Used when SERPER_API_KEY is absent. Keeps the graph running (and the demo
 * usable offline) instead of failing the whole request.
 */
export class DisabledWebSearchService implements WebSearchService {
  readonly name = "disabled";
  readonly enabled = false;

  async search(query: string): Promise<WebSearchResponse> {
    return { query, results: [], provider: this.name };
  }
}
