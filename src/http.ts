import { ENV, env } from "./env.js";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, KaiError } from "./errors.js";
import { parse } from "./json.js";
import { leveled, level, plain, redact } from "./log.js";
import { APIPromise, type Raw } from "./promise.js";
import { RETRY, delay, sleep } from "./retry.js";
import { browser, runtime } from "./runtime.js";
import type { Config, Fetch, Logger, LogLevel, RequestOptions, RetryPolicy } from "./types.js";
import { VERSION } from "./version.js";

const BASE = "https://api.hanzo.ai";
const TIMEOUT = 60_000;
const AGENT = `@hanzo/kai/${VERSION}`;
const RUNTIME = runtime();

type Method = "GET" | "POST";

/** What a client resolves from its config and the environment, its model aside. */
export interface Settings {
  readonly key: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly retry: RetryPolicy;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly logLevel: LogLevel;
  readonly logger: Logger;
  readonly fetch: Fetch;
}

/** One request as the retry loop sends it. */
interface Call {
  readonly tag: string;
  readonly method: Method;
  readonly url: string;
  readonly headers: Headers;
  readonly payload: unknown;
  readonly body: string | undefined;
  readonly timeout: number;
  readonly retry: RetryPolicy;
  readonly signal: AbortSignal | undefined;
}

function count(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new KaiError(`${name} must be a whole number of zero or more, got ${value}`);
  return value;
}

function span(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new KaiError(`${name} must be zero or more milliseconds, got ${value}`);
  return value;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new KaiError(`${name} must be more than zero milliseconds, got ${value}`);
  return value;
}

function fraction(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new KaiError(`${name} must be from 0 to 1, got ${value}`);
  return value;
}

function flag(name: string, value: boolean): boolean {
  if (typeof value !== "boolean") throw new KaiError(`${name} must be true or false, got ${String(value)}`);
  return value;
}

function statuses(name: string, value: Iterable<number>): Set<number> {
  const set = new Set(value);
  for (const s of set) {
    if (!Number.isInteger(s) || s < 100 || s > 599) throw new KaiError(`${name} must hold HTTP statuses, got ${String(s)}`);
  }
  return set;
}

/** `base` with `patch` laid over it, every field checked; the status set is copied. */
function policy(base: RetryPolicy, patch: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxRetries: count("retry.maxRetries", patch.maxRetries ?? base.maxRetries),
    backoffInitialMs: span("retry.backoffInitialMs", patch.backoffInitialMs ?? base.backoffInitialMs),
    backoffMaxMs: span("retry.backoffMaxMs", patch.backoffMaxMs ?? base.backoffMaxMs),
    backoffJitter: fraction("retry.backoffJitter", patch.backoffJitter ?? base.backoffJitter),
    httpStatuses: statuses("retry.httpStatuses", patch.httpStatuses ?? base.httpStatuses),
    respectRetryAfter: flag("retry.respectRetryAfter", patch.respectRetryAfter ?? base.respectRetryAfter),
    maxRetryAfterMs: span("retry.maxRetryAfterMs", patch.maxRetryAfterMs ?? base.maxRetryAfterMs),
    apiConnectionError: flag("retry.apiConnectionError", patch.apiConnectionError ?? base.apiConnectionError),
    apiTimeoutError: flag("retry.apiTimeoutError", patch.apiTimeoutError ?? base.apiTimeoutError),
  };
}

/** Whether the policy retries an error thrown before any response arrived. */
function again(error: unknown, retry: RetryPolicy): boolean {
  if (error instanceof APITimeoutError) return retry.apiTimeoutError;
  if (error instanceof APIConnectionError) return retry.apiConnectionError;
  return false;
}

/** A clone's body as text, so the response itself stays unread; rejects once the signal aborts. */
function text(response: Response, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    response
      .clone()
      .text()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * Each setting from `config`, else its environment variable, else its default.
 *
 * @throws {KaiError} No API key, a setting out of range, no fetch, or a browser page without `dangerouslyAllowBrowser`.
 */
export function settings(config: Omit<Config, "model">): Settings {
  if (browser() && !config.dangerouslyAllowBrowser) {
    throw new KaiError(
      "Kai will not run in a browser page, where anyone using the page can read the API key; " +
        "call it from a server, or pass dangerouslyAllowBrowser: true to accept that",
    );
  }
  const key = config.apiKey ?? env(ENV.apiKey);
  if (!key) throw new KaiError(`no API key: pass apiKey, or set ${ENV.apiKey}`);
  const fromEnv = env(ENV.logLevel);
  const logLevel =
    config.logLevel !== undefined
      ? level(config.logLevel, "the logLevel option")
      : fromEnv !== undefined
        ? level(fromEnv, ENV.logLevel)
        : "warn";
  if (config.fetch === undefined && typeof globalThis.fetch !== "function") {
    throw new KaiError("this runtime has no global fetch; pass one as the fetch option");
  }
  return {
    key,
    baseURL: (config.baseURL ?? env(ENV.baseURL) ?? BASE).replace(/\/+$/, ""),
    timeout: positive("timeout", config.timeout ?? TIMEOUT),
    retry: policy(RETRY, config.retry),
    defaultHeaders: { ...config.defaultHeaders },
    logLevel,
    logger: leveled(config.logger ?? plain, logLevel),
    fetch: config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  };
}

/** Sends requests with auth, retries, timeouts and logging; each client holds one. */
export class Http {
  readonly #s: Settings;
  #count = 0;

  constructor(s: Settings) {
    this.#s = s;
  }

  /** A request whose 2xx body `read` turns into the result; anything else rejects with an error. */
  send<T>(
    method: Method,
    path: string,
    options: RequestOptions,
    payload: unknown,
    read: (data: unknown) => T,
  ): APIPromise<T> {
    const s = this.#s;
    const headers = new Headers(s.defaultHeaders);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.set("authorization", `Bearer ${s.key}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", AGENT);
    headers.set("x-kai-runtime", RUNTIME);
    headers.delete("x-kai-retry-count");
    if (payload !== undefined) headers.set("content-type", "application/json");
    const call: Call = {
      tag: `#${++this.#count} ${method} ${path}`,
      method,
      url: `${s.baseURL}${path}`,
      headers,
      payload,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeout: options.timeout === undefined ? s.timeout : positive("timeout", options.timeout),
      retry: options.retry === undefined ? s.retry : policy(s.retry, options.retry),
      signal: options.signal,
    };
    return new APIPromise(this.#run(call), (raw) => {
      const data = parse(raw.text);
      s.logger.debug(`${call.tag} <- body`, data);
      return read(data);
    });
  }

  /** Attempts until a response is final: a 2xx, a status not retried, or no retries left. */
  async #run(call: Call): Promise<Raw> {
    const { tag, retry } = call;
    const { logger } = this.#s;
    for (let attempt = 0; ; attempt++) {
      const left = retry.maxRetries - attempt;
      const headers = new Headers(call.headers);
      if (attempt > 0) headers.set("x-kai-retry-count", String(attempt));
      logger.debug(`${tag} -> ${call.url}`, { headers: redact(headers), body: call.payload });
      const started = Date.now();
      let raw: Raw;
      try {
        raw = await this.#attempt(call, headers);
      } catch (error) {
        if (left <= 0 || !again(error, retry)) throw error;
        await this.#pause(call, attempt, left, (error as Error).message);
        continue;
      }
      const { status, headers: got } = raw.response;
      const id = got.get("x-request-id");
      logger.info(`${tag} <- ${status} in ${Date.now() - started} ms${id ? ` (request ${id})` : ""}`);
      if (raw.response.ok) return raw;
      const data = parse(raw.text);
      logger.debug(`${tag} <- error body`, data);
      const error = APIError.from(status, data, got);
      if (left <= 0 || !retry.httpStatuses.has(status)) throw error;
      await this.#pause(call, attempt, left, String(status), got);
    }
  }

  /** One round trip, body included, under the timeout and the caller's signal. */
  async #attempt({ tag, method, url, body, timeout, signal }: Call, headers: Headers): Promise<Raw> {
    if (signal?.aborted) throw new APIUserAbortError({ cause: signal.reason });
    const { logger, fetch } = this.#s;
    const controller = new AbortController();
    const cancel = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeout);
    const started = Date.now();
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      return { response, text: await text(response, controller.signal) };
    } catch (cause) {
      const ms = Date.now() - started;
      if (signal?.aborted) {
        logger.info(`${tag} aborted after ${ms} ms`);
        throw new APIUserAbortError({ cause });
      }
      if (expired) {
        logger.info(`${tag} timed out after ${ms} ms`);
        throw new APITimeoutError(timeout, { cause });
      }
      logger.info(`${tag} connection failed after ${ms} ms`, cause);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new APIConnectionError(`connection failed: ${reason}`, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  /** Waits out the delay before the next attempt; the caller's signal ends the wait. */
  async #pause({ tag, retry, signal }: Call, attempt: number, left: number, reason: string, headers?: Headers): Promise<void> {
    const { logger } = this.#s;
    const ms = delay(attempt, retry, headers);
    logger.info(`${tag} retrying in ${ms} ms (${attempt + 1}/${attempt + left}) after ${reason}`);
    try {
      await sleep(ms, signal);
    } catch (cause) {
      logger.info(`${tag} aborted while waiting to retry`);
      throw new APIUserAbortError({ cause });
    }
  }
}
