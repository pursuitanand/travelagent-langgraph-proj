import type { WebSearchResponse, WebSearchResult } from "../domain/types.js";
import type { Logger } from "../util/logger.js";
import { silentLogger } from "../util/logger.js";
import type { WebSearchOptions, WebSearchService } from "./WebSearchService.js";

export interface SerperSearchServiceOptions {
  /** Read from SERPER_API_KEY. Never sent to, or exposed by, the frontend. */
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  maxResults?: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Subset of the Serper response we rely on. */
interface SerperPayload {
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    position?: number;
    date?: string;
  }>;
  answerBox?: { answer?: string; snippet?: string; title?: string; link?: string };
  knowledgeGraph?: { title?: string; description?: string; descriptionLink?: string };
}

export class SerperTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Serper request timed out after ${timeoutMs}ms`);
    this.name = "SerperTimeoutError";
  }
}

export class SerperRequestError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Serper request failed with HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "SerperRequestError";
    this.status = status;
  }
}

/**
 * Thin client for https://serper.dev.
 *
 * The API key lives only in this process (injected from the environment) and
 * is never echoed into responses or logs.
 */
export class SerperSearchService implements WebSearchService {
  readonly name = "serper";

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SerperSearchServiceOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint ?? "https://google.serper.dev/search";
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.maxResults = options.maxResults ?? 5;
    this.logger = options.logger ?? silentLogger;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
    if (!this.enabled) {
      return { query, results: [], provider: this.name };
    }

    const num = options.maxResults ?? this.maxResults;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "X-API-KEY": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          num,
          ...(options.country ? { gl: options.country } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new SerperRequestError(response.status, await safeText(response));
      }

      const payload = (await response.json()) as SerperPayload;
      const results: WebSearchResult[] = (payload.organic ?? [])
        .filter((item) => Boolean(item.link))
        .slice(0, num)
        .map((item, index) => ({
          title: item.title?.trim() || item.link || "Untitled result",
          link: item.link as string,
          snippet: item.snippet?.trim() ?? "",
          position: item.position ?? index + 1,
          source: hostnameOf(item.link as string),
        }));

      const answerBox =
        payload.answerBox?.answer?.trim() ||
        payload.answerBox?.snippet?.trim() ||
        payload.knowledgeGraph?.description?.trim();

      this.logger.debug("serper search completed", { resultCount: results.length });

      return {
        query,
        results,
        provider: this.name,
        ...(answerBox ? { answerBox } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SerperTimeoutError(this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

function hostnameOf(link: string): string | undefined {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
