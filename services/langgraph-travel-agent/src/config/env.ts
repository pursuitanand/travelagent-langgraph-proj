import { z } from "zod";
import type { LogLevel } from "../util/logger.js";

/** Accepts the usual truthy spellings; falls back to `fallback` when unset. */
const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ""
        ? fallback
        : ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()),
    );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  CORS_ALLOWED_ORIGINS: z.string().default("*"),

  FLIGHT_REPOSITORY: z.enum(["json", "postgres", "duffel"]).default("json"),
  FLIGHTS_DATA_FILE: z.string().default("data/flights.json"),
  FLIGHTS_ROLL_DATES: booleanish(true),

  DATABASE_URL: z.string().default(""),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: booleanish(false),

  DUFFEL_ACCESS_TOKEN: z.string().default(""),
  DUFFEL_ENDPOINT: z.string().url().default("https://api.duffel.com"),
  DUFFEL_API_VERSION: z.string().default("v2"),
  DUFFEL_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  // Duffel accepts 2000-60000 ms for how long it waits on each airline.
  DUFFEL_SUPPLIER_TIMEOUT_MS: z.coerce.number().int().min(2000).max(60_000).default(20_000),
  DUFFEL_MAX_CONNECTIONS: z.coerce.number().int().min(0).max(2).default(1),
  DUFFEL_MAX_FLEXIBILITY_REQUESTS: z.coerce.number().int().min(0).max(6).default(2),
  DUFFEL_HEALTH_CACHE_MS: z.coerce.number().int().nonnegative().default(60_000),

  SERPER_API_KEY: z.string().default(""),
  SERPER_ENDPOINT: z.string().url().default("https://google.serper.dev/search"),
  SERPER_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  SERPER_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(5),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: LogLevel;
  corsAllowedOrigins: string[] | "*";
  flights: {
    driver: "json" | "postgres" | "duffel";
    dataFile: string;
    rollDates: boolean;
  };
  database: {
    url: string;
    poolMax: number;
    ssl: boolean;
  };
  duffel: {
    accessToken: string;
    endpoint: string;
    apiVersion: string;
    timeoutMs: number;
    supplierTimeoutMs: number;
    maxConnections: number;
    maxFlexibilityRequests: number;
    healthCacheMs: number;
    enabled: boolean;
  };
  serper: {
    apiKey: string;
    endpoint: string;
    timeoutMs: number;
    maxResults: number;
    enabled: boolean;
  };
  anthropic: {
    apiKey: string;
    model: string;
    maxTokens: number;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    timeoutMs: number;
    enabled: boolean;
  };
}

/**
 * Parses and validates process environment into a typed config object.
 * Throws a readable aggregate error when required values are malformed, so a
 * misconfigured container fails fast at startup instead of at first request.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  if (e.FLIGHT_REPOSITORY === "postgres" && e.DATABASE_URL.trim() === "") {
    throw new Error("FLIGHT_REPOSITORY=postgres requires DATABASE_URL to be set");
  }

  if (e.FLIGHT_REPOSITORY === "duffel" && e.DUFFEL_ACCESS_TOKEN.trim() === "") {
    throw new Error("FLIGHT_REPOSITORY=duffel requires DUFFEL_ACCESS_TOKEN to be set");
  }

  // Our abort deadline must outlast the window Duffel spends polling airlines,
  // otherwise every slow search is reported as a client timeout.
  if (e.DUFFEL_TIMEOUT_MS <= e.DUFFEL_SUPPLIER_TIMEOUT_MS) {
    throw new Error(
      `DUFFEL_TIMEOUT_MS (${e.DUFFEL_TIMEOUT_MS}) must be greater than ` +
        `DUFFEL_SUPPLIER_TIMEOUT_MS (${e.DUFFEL_SUPPLIER_TIMEOUT_MS})`,
    );
  }

  const origins = e.CORS_ALLOWED_ORIGINS.trim();

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    corsAllowedOrigins:
      origins === "*" || origins === ""
        ? "*"
        : origins.split(",").map((o) => o.trim()).filter(Boolean),
    flights: {
      driver: e.FLIGHT_REPOSITORY,
      dataFile: e.FLIGHTS_DATA_FILE,
      rollDates: e.FLIGHTS_ROLL_DATES,
    },
    database: {
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      ssl: e.DATABASE_SSL,
    },
    duffel: {
      accessToken: e.DUFFEL_ACCESS_TOKEN,
      endpoint: e.DUFFEL_ENDPOINT,
      apiVersion: e.DUFFEL_API_VERSION,
      timeoutMs: e.DUFFEL_TIMEOUT_MS,
      supplierTimeoutMs: e.DUFFEL_SUPPLIER_TIMEOUT_MS,
      maxConnections: e.DUFFEL_MAX_CONNECTIONS,
      maxFlexibilityRequests: e.DUFFEL_MAX_FLEXIBILITY_REQUESTS,
      healthCacheMs: e.DUFFEL_HEALTH_CACHE_MS,
      enabled: e.DUFFEL_ACCESS_TOKEN.trim().length > 0,
    },
    serper: {
      apiKey: e.SERPER_API_KEY,
      endpoint: e.SERPER_ENDPOINT,
      timeoutMs: e.SERPER_TIMEOUT_MS,
      maxResults: e.SERPER_MAX_RESULTS,
      enabled: e.SERPER_API_KEY.trim().length > 0,
    },
    anthropic: {
      apiKey: e.ANTHROPIC_API_KEY,
      model: e.ANTHROPIC_MODEL,
      maxTokens: e.ANTHROPIC_MAX_TOKENS,
      effort: e.ANTHROPIC_EFFORT,
      timeoutMs: e.ANTHROPIC_TIMEOUT_MS,
      enabled: e.ANTHROPIC_API_KEY.trim().length > 0,
    },
  };
}
