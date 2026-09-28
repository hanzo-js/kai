import { KaiError } from "./errors.js";
import type { Logger, LogLevel } from "./types.js";

/** Log levels, most verbose first. */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error", "off"];

/** The level named by `value`; refuses anything else, naming where it came from. */
export function level(value: string, source: string): LogLevel {
  const found = LOG_LEVELS.find((l) => l === value);
  if (found) return found;
  throw new KaiError(`log level "${value}" from ${source} is not one of ${LOG_LEVELS.join(", ")}`);
}

/** Writes to the console, each line prefixed "[kai]". */
export const plain: Logger = {
  debug: (message, ...args) => console.debug(`[kai] ${message}`, ...args),
  info: (message, ...args) => console.info(`[kai] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[kai] ${message}`, ...args),
  error: (message, ...args) => console.error(`[kai] ${message}`, ...args),
};

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };

const silent = (): void => {};

/** The logger with calls below `at` dropped. */
export function leveled(logger: Logger, at: LogLevel): Logger {
  const on = (l: LogLevel): boolean => RANK[l] >= RANK[at];
  return {
    debug: on("debug") ? (message, ...args) => logger.debug(message, ...args) : silent,
    info: on("info") ? (message, ...args) => logger.info(message, ...args) : silent,
    warn: on("warn") ? (message, ...args) => logger.warn(message, ...args) : silent,
    error: on("error") ? (message, ...args) => logger.error(message, ...args) : silent,
  };
}

const SCHEMED = new Set(["authorization", "proxy-authorization"]);
const SECRET = new Set(["cookie", "set-cookie", "x-api-key"]);

/** Headers as a record with every credential masked; an auth scheme stays readable. */
export function redact(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (SCHEMED.has(name)) out[name] = value.includes(" ") ? `${value.split(" ")[0]} ***` : "***";
    else if (SECRET.has(name)) out[name] = "***";
    else out[name] = value;
  });
  return out;
}
