import { describe, expect, it, vi } from "vitest";
import {
  SerperRequestError,
  SerperSearchService,
  SerperTimeoutError,
} from "../src/services/SerperSearchService.js";
import { DisabledWebSearchService } from "../src/services/WebSearchService.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE = {
  answerBox: { answer: "No visa is required for stays under 90 days." },
  organic: [
    {
      title: "Japan visa guide",
      link: "https://www.example.com/japan-visa",
      snippet: "Visitors from many countries may enter visa-free.",
      position: 1,
    },
    {
      title: "Tokyo in October",
      link: "https://travel.example.org/tokyo-october",
      snippet: "Mild days and low rainfall.",
      position: 2,
    },
  ],
};

describe("SerperSearchService", () => {
  it("posts the query with the API key header and maps the response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SAMPLE));
    const service = new SerperSearchService({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await service.search("tokyo visa requirements", { maxResults: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://google.serper.dev/search");
    expect((init.headers as Record<string, string>)["X-API-KEY"]).toBe("test-key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      q: "tokyo visa requirements",
      num: 2,
    });

    expect(result.provider).toBe("serper");
    expect(result.answerBox).toBe("No visa is required for stays under 90 days.");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      title: "Japan visa guide",
      link: "https://www.example.com/japan-visa",
      source: "example.com",
      position: 1,
    });
  });

  it("truncates to the requested number of results", async () => {
    const service = new SerperSearchService({
      apiKey: "test-key",
      fetchImpl: (async () => jsonResponse(SAMPLE)) as unknown as typeof fetch,
    });

    const result = await service.search("tokyo", { maxResults: 1 });
    expect(result.results).toHaveLength(1);
  });

  it("drops entries that have no link", async () => {
    const service = new SerperSearchService({
      apiKey: "test-key",
      fetchImpl: (async () =>
        jsonResponse({ organic: [{ title: "no link here" }, SAMPLE.organic[0]] })) as unknown as typeof fetch,
    });

    const result = await service.search("tokyo");
    expect(result.results).toHaveLength(1);
  });

  it("raises a typed error on a non-2xx response", async () => {
    const service = new SerperSearchService({
      apiKey: "test-key",
      fetchImpl: (async () => new Response("quota exceeded", { status: 429 })) as unknown as typeof fetch,
    });

    await expect(service.search("tokyo")).rejects.toBeInstanceOf(SerperRequestError);
  });

  it("raises a typed error when the request is aborted", async () => {
    const service = new SerperSearchService({
      apiKey: "test-key",
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })) as unknown as typeof fetch,
    });

    await expect(service.search("tokyo")).rejects.toBeInstanceOf(SerperTimeoutError);
  });

  it("reports itself as disabled and short-circuits without a key", async () => {
    const fetchImpl = vi.fn();
    const service = new SerperSearchService({
      apiKey: "  ",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(service.enabled).toBe(false);
    await expect(service.search("tokyo")).resolves.toEqual({
      query: "tokyo",
      results: [],
      provider: "serper",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DisabledWebSearchService", () => {
  it("returns an empty result set", async () => {
    const service = new DisabledWebSearchService();
    expect(service.enabled).toBe(false);
    await expect(service.search("anything")).resolves.toEqual({
      query: "anything",
      results: [],
      provider: "disabled",
    });
  });
});
