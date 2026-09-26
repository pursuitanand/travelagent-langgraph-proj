import { randomUUID } from "node:crypto";
import cors, { type CorsOptions } from "cors";
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { TravelGraph } from "../graph/buildGraph.js";
import { runTravelAgent } from "../graph/buildGraph.js";
import type { FlightRepository } from "../repositories/FlightRepository.js";
import { HttpError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export interface AppOptions {
  config: AppConfig;
  graph: TravelGraph;
  flights: FlightRepository;
  logger: Logger;
  version?: string;
}

const chatRequestSchema = z.object({
  message: z.string().trim().min(1, "message must not be empty").max(2000),
  conversationId: z.string().trim().max(128).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
      }),
    )
    .max(20)
    .optional(),
});

export function createApp(options: AppOptions): Application {
  const { config, graph, flights, logger } = options;
  const app = express();
  const startedAt = Date.now();
  const version = options.version ?? "1.0.0";

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const corsOptions: CorsOptions =
    config.corsAllowedOrigins === "*"
      ? { origin: true }
      : { origin: config.corsAllowedOrigins };
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "32kb" }));

  // Correlation id + access log.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.header("x-request-id") ?? randomUUID()).slice(0, 64);
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      // Probes would otherwise dominate the log.
      const level = req.path === "/health" ? "debug" : "info";
      logger[level]("request", {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  });

  // -------------------------------------------------------------------------
  // GET /health - used by both the readiness and the liveness probe.
  // -------------------------------------------------------------------------
  app.get("/health", async (_req: Request, res: Response) => {
    const flightsHealth = await flights.healthCheck();
    const healthy = flightsHealth.healthy;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks: {
        flights: { driver: flights.name, ...flightsHealth },
      },
      features: {
        webSearch: config.serper.enabled,
        llm: config.anthropic.enabled ? config.anthropic.model : "template-fallback",
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/chat - runs one pass of the LangGraph agent.
  // -------------------------------------------------------------------------
  app.post("/api/chat", async (req: Request, res: Response, next: NextFunction) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      next(
        new HttpError(
          400,
          "Invalid request body",
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    const { message, history, conversationId } = parsed.data;
    const startedNs = process.hrtime.bigint();

    try {
      const state = await runTravelAgent(graph, {
        message,
        ...(history ? { history } : {}),
      });

      const durationMs = Math.round(Number(process.hrtime.bigint() - startedNs) / 1e6);
      const intent = state.intent;

      res.json({
        conversationId: conversationId ?? randomUUID(),
        reply: state.reply,
        intent: intent
          ? {
              origin: intent.origin,
              destination: intent.destination,
              departureDate: intent.departureDate,
              returnDate: intent.returnDate,
              passengers: intent.passengers,
              cabinClass: intent.cabinClass,
              maxPrice: intent.maxPrice,
              topics: intent.topics,
              searchable: intent.searchable,
            }
          : null,
        flights: {
          outbound: state.outboundOffers,
          inbound: state.inboundOffers,
        },
        sources: state.webResults.map((result) => ({
          title: result.title,
          link: result.link,
          source: result.source ?? null,
        })),
        diagnostics: {
          trace: state.trace,
          responder: state.responder,
          notes: state.brief?.notes ?? [],
          errors: state.errors,
          durationMs,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (res.locals.requestId as string | undefined) ?? "unknown";

    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: error.message,
        details: error.details ?? null,
        requestId,
      });
      return;
    }

    logger.error("unhandled request error", {
      requestId,
      path: req.path,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "internal_error", requestId });
  });

  return app;
}
