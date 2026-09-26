import type { LogLevel } from "./logger.js";

export type { LogLevel };

export interface FrontendConfig {
  port: number;
  nodeEnv: string;
  logLevel: LogLevel;
  /**
   * Base URL of langgraph-travel-agent.
   *
   * In Kubernetes this must be the in-cluster service DNS name
   * (http://langgraph-travel-agent.travel-agent.svc.cluster.local:8080), never
   * localhost - the two services run in separate pods.
   */
  backendUrl: string;
  backendTimeoutMs: number;
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received "${value}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FrontendConfig {
  const backendUrl = (env.BACKEND_URL ?? "http://localhost:8080").replace(/\/+$/, "");

  // `new URL("agent:8080")` parses happily, so the protocol must be checked
  // explicitly - fetch only accepts http(s).
  let parsedBackend: URL;
  try {
    parsedBackend = new URL(backendUrl);
  } catch {
    throw new Error(`BACKEND_URL must be an absolute http(s) URL, received "${backendUrl}"`);
  }
  if (parsedBackend.protocol !== "http:" && parsedBackend.protocol !== "https:") {
    throw new Error(`BACKEND_URL must be an absolute http(s) URL, received "${backendUrl}"`);
  }

  const logLevel = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  return {
    port: positiveInt(env.PORT, 3000, "PORT"),
    nodeEnv: env.NODE_ENV ?? "development",
    logLevel,
    backendUrl,
    backendTimeoutMs: positiveInt(env.BACKEND_TIMEOUT_MS, 60_000, "BACKEND_TIMEOUT_MS"),
  };
}
