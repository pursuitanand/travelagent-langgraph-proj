import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildApp(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    BACKEND_URL: "http://langgraph-travel-agent.travel-agent.svc.cluster.local:8080",
    LOG_LEVEL: "silent",
    ...env,
  });
  return createServer({ config, logger: silentLogger, fetchImpl, publicDir: PUBLIC_DIR });
}

describe("loadConfig", () => {
  it("defaults to a localhost backend for local development", () => {
    const config = loadConfig({});
    expect(config.backendUrl).toBe("http://localhost:8080");
    expect(config.port).toBe(3000);
  });

  it("trims a trailing slash off BACKEND_URL", () => {
    expect(loadConfig({ BACKEND_URL: "http://agent:8080/" }).backendUrl).toBe("http://agent:8080");
  });

  it("rejects a non-absolute BACKEND_URL", () => {
    expect(() => loadConfig({ BACKEND_URL: "agent:8080" })).toThrow("absolute http(s) URL");
    expect(() => loadConfig({ BACKEND_URL: "not a url" })).toThrow("absolute http(s) URL");
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/positive integer/);
  });
});

describe("GET /health", () => {
  it("is independent of the backend so liveness never flaps", async () => {
    const fetchImpl = vi.fn();
    const app = buildApp(fetchImpl as unknown as typeof fetch);

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({ status: "ok", service: "chat-assistant" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat", () => {
  it("forwards the body to the backend service DNS name and returns its reply", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ reply: "Here are your flights", flights: { outbound: [], inbound: [] } }),
    );
    const app = buildApp(fetchImpl as unknown as typeof fetch);

    const response = await request(app)
      .post("/api/chat")
      .send({ message: "London to Tokyo" })
      .expect(200);

    expect(response.body.reply).toBe("Here are your flights");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://langgraph-travel-agent.travel-agent.svc.cluster.local:8080/api/chat",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ message: "London to Tokyo" });
  });

  it("propagates the correlation id upstream", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ reply: "ok" }));
    const app = buildApp(fetchImpl as unknown as typeof fetch);

    await request(app)
      .post("/api/chat")
      .set("x-request-id", "req-42")
      .send({ message: "hello" })
      .expect(200);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-request-id"]).toBe("req-42");
  });

  it("passes a backend validation error straight through", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Invalid request body" }, 400));
    const app = buildApp(fetchImpl as unknown as typeof fetch);

    const response = await request(app).post("/api/chat").send({ message: "" }).expect(400);
    expect(response.body.error).toBe("Invalid request body");
  });

  it("returns 502 with a friendly message when the backend is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const app = buildApp(fetchImpl as unknown as typeof fetch);

    const response = await request(app).post("/api/chat").send({ message: "hi" }).expect(502);

    expect(response.body.error).toMatch(/unavailable/i);
    expect(response.body.requestId).toBeTruthy();
    // The upstream failure detail must not leak to the browser.
    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
  });

  it("returns 504 when the backend exceeds the timeout", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    const app = buildApp(fetchImpl, { BACKEND_TIMEOUT_MS: "20" });
    const response = await request(app).post("/api/chat").send({ message: "hi" }).expect(504);

    expect(response.body.error).toMatch(/too long/i);
  });

  it("survives a backend response that is not JSON", async () => {
    const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    const app = buildApp(fetchImpl);

    const response = await request(app).post("/api/chat").send({ message: "hi" }).expect(200);
    expect(response.body.error).toMatch(/unreadable/i);
  });
});

describe("static assets", () => {
  it("serves the chat page at the root", async () => {
    const app = buildApp((async () => jsonResponse({})) as unknown as typeof fetch);
    const response = await request(app).get("/").expect(200);

    expect(response.text).toContain("<title>Travel Agent</title>");
    expect(response.headers["content-type"]).toMatch(/text\/html/);
  });

  it("serves the client script and stylesheet", async () => {
    const app = buildApp((async () => jsonResponse({})) as unknown as typeof fetch);
    await request(app).get("/app.js").expect(200);
    await request(app).get("/render.js").expect(200);
    await request(app).get("/styles.css").expect(200);
  });

  it("never ships an API key to the browser", async () => {
    const app = buildApp((async () => jsonResponse({})) as unknown as typeof fetch);
    const page = await request(app).get("/").expect(200);
    const script = await request(app).get("/app.js").expect(200);
    const render = await request(app).get("/render.js").expect(200);

    for (const body of [page.text, script.text, render.text]) {
      expect(body).not.toMatch(/SERPER_API_KEY|ANTHROPIC_API_KEY|sk-ant-/);
    }
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const app = buildApp((async () => jsonResponse({})) as unknown as typeof fetch);
    const response = await request(app).get("/does-not-exist").expect(404);
    expect(response.body).toEqual({ error: "not_found", path: "/does-not-exist" });
  });
});
