import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { parseTravelRequest } from "../src/domain/intentParser.js";
import { createTravelGraph, runTravelAgent } from "../src/graph/buildGraph.js";
import type { AgentDependencies } from "../src/graph/state.js";
import {
  createAgentMemory,
  emptyProfile,
  learnFromIntent,
  ProfileStore,
  SessionRegistry,
} from "../src/memory/index.js";
import { TemplateResponseGenerator } from "../src/services/ResponseGenerator.js";
import { silentLogger } from "../src/util/logger.js";
import { FakeFlightRepository, FakeWebSearchService, makeOffer } from "./helpers/fakes.js";

const NOW = new Date("2026-09-25T10:00:00Z");

function deps(overrides: Partial<AgentDependencies> = {}): AgentDependencies {
  return {
    flights: new FakeFlightRepository({ offers: [makeOffer()] }),
    web: new FakeWebSearchService(),
    responder: new TemplateResponseGenerator(),
    logger: silentLogger,
    now: () => NOW,
    ...overrides,
  };
}

describe("short-term memory (checkpointer, per thread)", () => {
  it("resolves a follow-up from the checkpoint without any client history", async () => {
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }));

    await runTravelAgent(graph, { message: "London to Tokyo on 20 October", threadId: "t1" });
    const second = await runTravelAgent(graph, {
      message: "what about business class?",
      threadId: "t1",
    });

    expect(second.memorySource).toBe("checkpoint");
    expect(second.intent?.origin?.iata).toBe("LHR");
    expect(flights.queries[1]).toMatchObject({ destination: "NRT", cabinClass: "business" });
  });

  it("keeps threads isolated from each other", async () => {
    const graph = createTravelGraph(deps());

    await runTravelAgent(graph, { message: "London to Tokyo on 20 October", threadId: "a" });
    const other = await runTravelAgent(graph, { message: "what about business?", threadId: "b" });

    expect(other.memorySource).toBe("empty");
    expect(other.intent?.origin).toBeNull();
  });

  it("resets turn-scoped channels at the start of every turn", async () => {
    const graph = createTravelGraph(deps());

    await runTravelAgent(graph, { message: "London to Tokyo on 20 October", threadId: "t2" });
    const second = await runTravelAgent(graph, { message: "and in business?", threadId: "t2" });

    expect(second.trace[0]).toBe("loadMemory");
    expect(second.trace).toHaveLength(7);
  });

  it("trims the message window to memoryWindowTurns", async () => {
    const memory = createAgentMemory();
    const graph = createTravelGraph(deps({ memoryWindowTurns: 2 }), memory);

    for (const message of ["London to Tokyo", "on 20 October", "in business"]) {
      await runTravelAgent(graph, { message, threadId: "t3" });
    }

    const snapshot = await graph.getState({ configurable: { thread_id: "t3" } });
    const messages = snapshot.values.messages as Array<{ content: string }>;
    expect(messages).toHaveLength(4);
    expect(messages[0]?.content).toBe("on 20 October");
  });

  it("re-seeds from the client transcript when server memory is stale", async () => {
    const graph = createTravelGraph(deps());

    await runTravelAgent(graph, { message: "London to Tokyo", threadId: "t4" });
    // The client knows about a turn this replica never saw.
    const state = await runTravelAgent(graph, {
      message: "what about business class?",
      threadId: "t4",
      history: [
        { role: "user", content: "Paris to Dubai on 20 October" },
        { role: "assistant", content: "Here are flights to Dubai..." },
      ],
    });

    expect(state.memorySource).toBe("client-history");
    expect(state.intent?.destination?.iata).toBe("DXB");
  });
});

describe("multiple schemas", () => {
  it("returns only the output schema, never private working memory", async () => {
    const graph = createTravelGraph(deps());
    const state = await runTravelAgent(graph, { message: "London to Tokyo on 20 October" });

    expect(state).toHaveProperty("reply");
    expect(state).not.toHaveProperty("messages");
    expect(state).not.toHaveProperty("lastIntent");
    expect(state).not.toHaveProperty("webAnswer");
    expect(state).not.toHaveProperty("history");
  });

  it("ignores private keys a caller tries to inject through the input", async () => {
    const graph = createTravelGraph(deps());
    await graph.invoke(
      {
        message: "hello",
        messages: [{ role: "user", content: "INJECTED" }],
        lastIntent: { bogus: true },
      } as unknown as { message: string },
      { configurable: { thread_id: "inject" } },
    );

    const snapshot = await graph.getState({ configurable: { thread_id: "inject" } });
    const messages = snapshot.values.messages as Array<{ content: string }>;
    expect(messages.map((m) => m.content)).not.toContain("INJECTED");
    expect(snapshot.values.lastIntent).not.toHaveProperty("bogus");
  });

  it("gives the search branches only the intent", () => {
    const graph = createTravelGraph(deps());
    // `builder.nodes[name].input` is the channel set LangGraph reads for that node.
    const nodes = (graph.builder as unknown as {
      nodes: Record<string, { input?: Record<string, unknown> }>;
    }).nodes;

    expect(Object.keys(nodes.flightSearch?.input ?? {})).toEqual(["intent"]);
    expect(Object.keys(nodes.webSearch?.input ?? {})).toEqual(["intent"]);
    expect(Object.keys(nodes.parseRequest?.input ?? {})).toContain("messages");
  });
});

describe("long-term memory (store, per user)", () => {
  it("learns a home airport and applies it in a later session", async () => {
    const memory = createAgentMemory();
    const flights = new FakeFlightRepository({ offers: [makeOffer()] });
    const graph = createTravelGraph(deps({ flights }), memory);

    await runTravelAgent(graph, {
      message: "London to Tokyo on 20 October in business",
      threadId: "s1",
      userId: "u1",
    });
    const later = await runTravelAgent(graph, {
      message: "flights to Tokyo on 22 October",
      threadId: "s2",
      userId: "u1",
    });

    expect(later.intent?.origin?.iata).toBe("LHR");
    expect(later.notes.join(" ")).toContain("usual airport, London (LHR)");
    expect(later.profile).toMatchObject({ preferredCabin: "business", searchesObserved: 2 });
  });

  it("never shares a profile across users", async () => {
    const memory = createAgentMemory();
    const graph = createTravelGraph(deps(), memory);

    await runTravelAgent(graph, { message: "London to Tokyo", userId: "alice" });
    const bob = await runTravelAgent(graph, { message: "flights to Tokyo", userId: "bob" });

    expect(bob.intent?.origin).toBeNull();
    expect(await memory.profiles.load("bob")).toBeNull();
  });

  it("learns nothing from an incomplete request", () => {
    const profile = emptyProfile();
    const intent = parseTravelRequest("is it rainy in May?", { now: NOW });
    expect(learnFromIntent(profile, intent, NOW)).toBe(profile);
  });

  it("keeps recent destinations unique, newest first, capped at five", () => {
    let profile = emptyProfile();
    for (const city of ["Tokyo", "Paris", "Dubai", "Tokyo", "Singapore", "Sydney", "New York"]) {
      profile = learnFromIntent(profile, parseTravelRequest(`London to ${city}`, { now: NOW }), NOW);
    }
    expect(profile.recentDestinations).toHaveLength(5);
    expect(profile.recentDestinations[0]).toContain("New York");
    expect(profile.recentDestinations.filter((d) => d.startsWith("Tokyo"))).toHaveLength(1);
  });

  it("ignores a stored record that fails schema validation", async () => {
    const store = new InMemoryStore();
    await store.put(ProfileStore.namespace("u9"), ProfileStore.KEY, { homeAirport: "LHR" });
    expect(await new ProfileStore(store).load("u9")).toBeNull();
  });
});

describe("SessionRegistry", () => {
  function registry(options: { ttlMs?: number; maxSessions?: number } = {}) {
    let now = NOW.getTime();
    const checkpointer = new MemorySaver();
    const deleteThread = vi.spyOn(checkpointer, "deleteThread");
    const sessions = new SessionRegistry({
      checkpointer,
      ttlMs: options.ttlMs ?? 60_000,
      maxSessions: options.maxSessions ?? 10,
      now: () => new Date(now),
    });
    return { sessions, deleteThread, advance: (ms: number) => (now += ms) };
  }

  it("counts turns and keeps the user id", async () => {
    const { sessions } = registry();
    await sessions.begin("s", "u");
    sessions.complete("s");
    await sessions.begin("s", null);
    expect(sessions.complete("s")).toMatchObject({ turns: 2, userId: "u" });
  });

  it("expires idle sessions and deletes their checkpoints", async () => {
    const { sessions, deleteThread, advance } = registry({ ttlMs: 1000 });
    await sessions.begin("old", null);
    advance(1500);
    await sessions.begin("new", null);

    expect(sessions.get("old")).toBeNull();
    expect(deleteThread).toHaveBeenCalledWith("old");
    expect(sessions.size).toBe(1);
  });

  it("evicts the least recently active session beyond the cap", async () => {
    const { sessions, deleteThread } = registry({ maxSessions: 2 });
    await sessions.begin("a", null);
    await sessions.begin("b", null);
    await sessions.begin("a", null); // touch a -> b is now the oldest
    await sessions.begin("c", null);

    expect(deleteThread).toHaveBeenCalledWith("b");
    expect(sessions.get("a")).not.toBeNull();
  });
});
