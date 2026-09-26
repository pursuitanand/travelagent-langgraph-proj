import "dotenv/config";
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: "chat-assistant" });

  logger.info("starting", {
    nodeEnv: config.nodeEnv,
    backendUrl: config.backendUrl,
  });

  const app = createServer({ config, logger });
  const server: Server = app.listen(config.port, () => {
    logger.info("listening", { port: config.port });
  });

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    server.close((error) => process.exit(error ? 1 : 0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
}
