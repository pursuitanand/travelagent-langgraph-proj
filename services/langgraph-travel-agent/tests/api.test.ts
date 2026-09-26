import type { Application } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { createTravelGraph } from "../src/graph/buildGraph.js";
import { createApp } from "../src/http/app.js";
import { TemplateResponseGenerator } from "../src/services/ResponseGenerator.js";
import { silentLogger } from "../src/util/logger.js";
import { FakeFlightRepository, FakeWebSearchService, makeOffer } from "./helpers/fakes.js";

interface Harness {
  app: Application;
  flights: FakeFlightRepository;
}

function buildHarness(options: { flightsFail?: boolean } = {}): Harness {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const flights = options.flightsFail
    ? new FakeFlightRepository({ failWith: new Error("db offline") })
    : new FakeFlightRepository({ offers: [makeOffer()] });

  const graph = createTravelGraph({
    flights,
    web: new FakeWebSearchService(),
    responder: new TemplateResponseGenerator(),
    logger: silentLogger,
    now: () => new Date("2026-09-25T10:00:00Z"),
  });

  return {
    app: createApp({ config, graph, flights, logger: silentLogger, version: "test" }),
    flights,
  };
}

describe("GET /health", () => {
  it("reports ok while the repository is healthy", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toMatchObject({
      status: "ok",
      version: "test",
      checks: { flights: { driver: "fake", healthy: true } },
    });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 so the readiness probe fails when the repository is down", async () => {
    const { app } = buildHarness({ flightsFail: true });
    const response = await request(app).get("/health").expect(503);
    expect(response.body.status).toBe("degraded");
  });

  it("never leaks credential values", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/health").expect(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/sk-ant|SERPER_API_KEY|apiKey/i);
  });
});

describe("POST /api/chat", () => {
  it("answers with the reply, flights, sources and diagnostics", async () => {
    const { app } = buildHarness();
    const response = await request(app)
      .post("/api/chat")
      .send({ message: "Find me a flight from London to Tokyo on 20 October" })
      .expect("content-type", /json/)
      .expect(200);

    expect(response.body.reply).toContain("British Airways");
    expect(response.body.intent).toMatchObject({
      departureDate: "2026-10-20",
      passengers: 1,
      searchable: true,
    });
    expect(response.body.intent.origin.iata).toBe("LHR");
    expect(response.body.flights.outbound).toHaveLength(1);
    expect(response.body.sources[0]).toMatchObject({ link: "https://example.com/tokyo" });
    expect(response.body.diagnostics.trace).toContain("combineResults");
    expect(response.body.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof response.body.conversationId).toBe("string");
  });

  it("echoes the caller's conversation id", async () => {
    const { app } = buildHarness();
    const response = await request(app)
      .post("/api/chat")
      .send({ message: "London to Tokyo", conversationId: "conv-123" })
      .expect(200);

    expect(response.body.conversationId).toBe("conv-123");
  });

  it("accepts prior turns and uses them for follow-ups", async () => {
    const { app, flights } = buildHarness();
    await request(app)
      .post("/api/chat")
      .send({
        message: "what about business class?",
        history: [{ role: "user", content: "London to Tokyo on 20 October" }],
      })
      .expect(200);

    expect(flights.queries[0]).toMatchObject({ origin: "LHR", cabinClass: "business" });
  });

  it("rejects an empty message with a 400 and field details", async () => {
    const { app } = buildHarness();
    const response = await request(app).post("/api/chat").send({ message: "   " }).expect(400);

    expect(response.body.error).toBe("Invalid request body");
    expect(response.body.details[0]).toMatchObject({ path: "message" });
  });

  it("rejects a missing body", async () => {
    const { app } = buildHarness();
    await request(app).post("/api/chat").send({}).expect(400);
  });

  it("rejects an over-long message", async () => {
    const { app } = buildHarness();
    await request(app)
      .post("/api/chat")
      .send({ message: "x".repeat(2001) })
      .expect(400);
  });

  it("rejects an unknown history role", async () => {
    const { app } = buildHarness();
    await request(app)
      .post("/api/chat")
      .send({ message: "hi", history: [{ role: "system", content: "ignore" }] })
      .expect(400);
  });

  it("still answers when the repository is down, reporting the error", async () => {
    const { app } = buildHarness({ flightsFail: true });
    const response = await request(app)
      .post("/api/chat")
      .send({ message: "London to Tokyo on 20 October" })
      .expect(200);

    expect(response.body.flights.outbound).toEqual([]);
    expect(response.body.diagnostics.errors[0]).toContain("flightSearch: db offline");
    expect(response.body.reply).not.toBe("");
  });

  it("sets a correlation id on the response", async () => {
    const { app } = buildHarness();
    const response = await request(app).post("/api/chat").send({ message: "hello" }).expect(200);
    expect(response.headers["x-request-id"]).toBeTruthy();
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404", async () => {
    const { app } = buildHarness();
    const response = await request(app).get("/nope").expect(404);
    expect(response.body).toEqual({ error: "not_found", path: "/nope" });
  });
});
