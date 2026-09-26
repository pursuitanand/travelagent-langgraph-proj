import "dotenv/config";
import type { Server } from "node:http";
import { loadConfig } from "./config/env.js";
import { createTravelGraph } from "./graph/buildGraph.js";
import { createApp } from "./http/app.js";
import { createFlightRepository } from "./repositories/index.js";
import { AnthropicResponseGenerator } from "./services/AnthropicResponseGenerator.js";
import { TemplateResponseGenerator } from "./services/ResponseGenerator.js";
import { SerperSearchService } from "./services/SerperSearchService.js";
import { DisabledWebSearchService } from "./services/WebSearchService.js";
import { createLogger } from "./util/logger.js";

const VERSION = process.env.SERVICE_VERSION ?? "1.0.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "langgraph-travel-agent" });

  logger.info("starting", {
    version: VERSION,
    nodeEnv: config.nodeEnv,
    flightRepository: config.flights.driver,
    webSearch: config.serper.enabled ? "serper" : "disabled",
    // Only ever log whether a key exists, never the key itself.
    llm: config.anthropic.enabled ? config.anthropic.model : "template-fallback",
  });

  const flights = createFlightRepository(config, logger);
  await flights.init();

  const web = config.serper.enabled
    ? new SerperSearchService({
        apiKey: config.serper.apiKey,
        endpoint: config.serper.endpoint,
        timeoutMs: config.serper.timeoutMs,
        maxResults: config.serper.maxResults,
        logger,
      })
    : new DisabledWebSearchService();

  const responder = config.anthropic.enabled
    ? new AnthropicResponseGenerator({
        apiKey: config.anthropic.apiKey,
        model: config.anthropic.model,
        maxTokens: config.anthropic.maxTokens,
        effort: config.anthropic.effort,
        timeoutMs: config.anthropic.timeoutMs,
        logger,
      })
    : new TemplateResponseGenerator();

  const graph = createTravelGraph({
    flights,
    web,
    responder,
    logger,
    now: () => new Date(),
  });

  const app = createApp({ config, graph, flights, logger, version: VERSION });
  const server: Server = app.listen(config.port, () => {
    logger.info("listening", { port: config.port });
  });

  // Kubernetes sends SIGTERM; drain in-flight requests before exiting.
  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    server.close(async (error) => {
      if (error) logger.error("error while closing server", { error: error.message });
      await flights.close().catch(() => undefined);
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => {
      logger.error("forced shutdown after timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // The logger may not exist yet, so write directly to stderr.
  process.stderr.write(`${JSON.stringify({ level: "fatal", msg: message })}\n`);
  process.exit(1);
});
