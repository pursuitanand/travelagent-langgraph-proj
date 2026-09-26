/* eslint-disable no-console */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Minimal structured JSON logger - one line per event, which is what the
 * `kubectl logs` / container-stdout collection path expects.
 */
export function createLogger(
  level: LogLevel = "info",
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;

  const emit = (
    logLevel: Exclude<LogLevel, "silent">,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[logLevel] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: logLevel,
      msg: message,
      ...bindings,
      ...fields,
    });
    if (logLevel === "error" || logLevel === "warn") console.error(line);
    else console.log(line);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

/** No-op logger for tests. */
export const silentLogger: Logger = createLogger("silent");
