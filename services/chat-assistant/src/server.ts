import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { FrontendConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";

export interface ServerOptions {
  config: FrontendConfig;
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Overridable so tests do not depend on the build layout. */
  publicDir?: string;
}

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/**
 * The chat UI server.
 *
 * It is deliberately thin: static assets plus a single pass-through to the
 * agent. No LangGraph, no provider SDKs and no API keys live here - the
 * browser talks only to this service, and this service talks only to
 * `BACKEND_URL`.
 */
export function createServer(options: ServerOptions): Application {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel, { service: "chat-assistant" });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;

  const app = express();
  const startedAt = Date.now();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  // Liveness + readiness. Deliberately local: the UI is still "up" and able to
  // explain itself even while the agent is restarting.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "chat-assistant",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      backendUrl: config.backendUrl,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/chat - forwards the message to langgraph-travel-agent.
  // -------------------------------------------------------------------------
  app.post("/api/chat", async (req: Request, res: Response) => {
    const requestId = res.locals.requestId as string;
    const target = `${config.backendUrl}/api/chat`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.backendTimeoutMs);
    const startedNs = process.hrtime.bigint();

    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify(req.body ?? {}),
        signal: controller.signal,
      });

      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6);
      const payload: unknown = await upstream.json().catch(() => ({
        error: "The agent returned an unreadable response.",
      }));

      logger.info("proxied chat request", {
        requestId,
        status: upstream.status,
        durationMs,
      });

      res.status(upstream.status).json(payload);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      logger.error("chat proxy failed", {
        requestId,
        target,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(aborted ? 504 : 502).json({
        error: aborted
          ? "The travel agent took too long to respond. Please try again."
          : "The travel agent is unavailable right now. Please try again shortly.",
        requestId,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  app.use(express.static(publicDir, { index: "index.html", maxAge: "5m" }));

  // Anything else is a 404 - this service has no client-side router.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}
