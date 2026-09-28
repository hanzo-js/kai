import { ENV, env } from "./env.js";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError, KaiError } from "./errors.js";
import { parse, record } from "./json.js";
import { leveled, level, plain, redact } from "./log.js";
import { APIPromise, type Raw } from "./promise.js";
import { check } from "./questions.js";
import { RETRY, delay, sleep } from "./retry.js";
import { browser, runtime } from "./runtime.js";
import type {
  Config,
  Decision,
  DecisionRequest,
  Fetch,
  Logger,
  LogLevel,
  Model,
  Models,
  Questions,
  RequestOptions,
  RetryPolicy,
} from "./types.js";
import { VERSION } from "./version.js";

const BASE = "https://api.hanzo.ai";
const MODEL = "kai";
const TIMEOUT = 60_000;
const AGENT = `@hanzo/kai/${VERSION}`;
const RUNTIME = runtime();

type Method = "GET" | "POST";

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

/** Keeps the answers whose type this client knows, warning about each one it skips. */
function decision(data: unknown, logger: Logger): Decision {
  if (!record(data) || !record(data.answers)) {
    throw new KaiError("POST /v1/decisions answered without an 'answers' object");
  }
  const answers: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(data.answers)) {
    const type = record(answer) ? answer.type : undefined;
    if (type === "noul" || type === "choice" || type === "score") answers[name] = answer;
    else logger.warn(`answer "${name}" has type ${JSON.stringify(type)}, which this client does not know; skipped`);
  }
  return { ...data, answers } as unknown as Decision;
}

/** The models whose outputs include "decision". */
function catalog(data: unknown): Model[] {
  if (!record(data) || !Array.isArray(data.data)) throw new KaiError("GET /v1/models answered without a 'data' list");
  return data.data.filter(
    (m): m is Model => record(m) && Array.isArray(m.outputs) && m.outputs.includes("decision"),
  );
}

/** Client for Kai decisions on api.hanzo.ai. */
export class Kai {
  readonly #key: string;
  /** API root, trailing slashes removed. */
  readonly baseURL: string;
  /** Model for calls that name none. */
  readonly model: string;
  /** Milliseconds per attempt. */
  readonly timeout: number;
  readonly retry: RetryPolicy;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly logLevel: LogLevel;
  /** The configured logger, narrowed to `logLevel`. */
  readonly logger: Logger;
  readonly fetch: Fetch;
  readonly models: Models;
  #count = 0;

  /**
   * Each setting comes from `config`, else its environment variable, else its default.
   *
   * @throws {KaiError} No API key, a setting out of range, no fetch, or a browser page without `dangerouslyAllowBrowser`.
   */
  constructor(config: Config = {}) {
    if (browser() && !config.dangerouslyAllowBrowser) {
      throw new KaiError(
        "Kai will not run in a browser page, where anyone using the page can read the API key; " +
          "call it from a server, or pass dangerouslyAllowBrowser: true to accept that",
      );
    }
    const key = config.apiKey ?? env(ENV.apiKey);
    if (!key) throw new KaiError(`no API key: pass apiKey, or set ${ENV.apiKey}`);
    this.#key = key;
    this.baseURL = (config.baseURL ?? env(ENV.baseURL) ?? BASE).replace(/\/+$/, "");
    this.model = config.model ?? env(ENV.model) ?? MODEL;
    this.timeout = positive("timeout", config.timeout ?? TIMEOUT);
    this.retry = policy(RETRY, config.retry);
    this.defaultHeaders = { ...config.defaultHeaders };
    const fromEnv = env(ENV.logLevel);
    this.logLevel =
      config.logLevel !== undefined
        ? level(config.logLevel, "the logLevel option")
        : fromEnv !== undefined
          ? level(fromEnv, ENV.logLevel)
          : "warn";
    this.logger = leveled(config.logger ?? plain, this.logLevel);
    if (config.fetch === undefined && typeof globalThis.fetch !== "function") {
      throw new KaiError("this runtime has no global fetch; pass one as the fetch option");
    }
    this.fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.models = {
      list: (options = {}) => this.#send("GET", "/v1/models", options, undefined, catalog),
    };
  }

  /**
   * Ask questions about a state; each answer comes back typed by its question.
   *
   * @throws {KaiError} No questions, or criteria of the wrong shape; thrown before anything is sent.
   * @example
   * const d = await kai.decide({
   *   state: "I was charged twice for March.",
   *   questions: { team: choice("Which team?", { billing: "charges", tech: "bugs" }) },
   * });
   * d.answers.team.choice; // "billing" | "tech"
   */
  decide<const Q extends Questions>(request: DecisionRequest<Q>, options: RequestOptions = {}): APIPromise<Decision<Q>> {
    check(request.questions);
    const { model, ...rest } = request;
    return this.#send("POST", "/v1/decisions", options, { model: model ?? this.model, ...rest }, (data) =>
      decision(data, this.logger) as Decision<Q>,
    );
  }

  #send<T>(
    method: Method,
    path: string,
    options: RequestOptions,
    payload: unknown,
    read: (data: unknown) => T,
  ): APIPromise<T> {
    const headers = new Headers(this.defaultHeaders);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.set("authorization", `Bearer ${this.#key}`);
    headers.set("accept", "application/json");
    headers.set("user-agent", AGENT);
    headers.set("x-kai-runtime", RUNTIME);
    headers.delete("x-kai-retry-count");
    if (payload !== undefined) headers.set("content-type", "application/json");
    const call: Call = {
      tag: `#${++this.#count} ${method} ${path}`,
      method,
      url: `${this.baseURL}${path}`,
      headers,
      payload,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      timeout: options.timeout === undefined ? this.timeout : positive("timeout", options.timeout),
      retry: options.retry === undefined ? this.retry : policy(this.retry, options.retry),
      signal: options.signal,
    };
    return new APIPromise(this.#run(call), (raw) => {
      const data = parse(raw.text);
      this.logger.debug(`${call.tag} <- body`, data);
      return read(data);
    });
  }

  /** Attempts until a response is final: a 2xx, a status not retried, or no retries left. */
  async #run(call: Call): Promise<Raw> {
    const { tag, retry } = call;
    for (let attempt = 0; ; attempt++) {
      const left = retry.maxRetries - attempt;
      const headers = new Headers(call.headers);
      if (attempt > 0) headers.set("x-kai-retry-count", String(attempt));
      this.logger.debug(`${tag} -> ${call.url}`, { headers: redact(headers), body: call.payload });
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
      this.logger.info(`${tag} <- ${status} in ${Date.now() - started} ms${id ? ` (request ${id})` : ""}`);
      if (raw.response.ok) return raw;
      const data = parse(raw.text);
      this.logger.debug(`${tag} <- error body`, data);
      const error = APIError.from(status, data, got);
      if (left <= 0 || !retry.httpStatuses.has(status)) throw error;
      await this.#pause(call, attempt, left, String(status), got);
    }
  }

  /** One round trip, body included, under the timeout and the caller's signal. */
  async #attempt({ tag, method, url, body, timeout, signal }: Call, headers: Headers): Promise<Raw> {
    if (signal?.aborted) throw new APIUserAbortError({ cause: signal.reason });
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
      const response = await this.fetch(url, { method, headers, body, signal: controller.signal });
      return { response, text: await text(response, controller.signal) };
    } catch (cause) {
      const ms = Date.now() - started;
      if (signal?.aborted) {
        this.logger.info(`${tag} aborted after ${ms} ms`);
        throw new APIUserAbortError({ cause });
      }
      if (expired) {
        this.logger.info(`${tag} timed out after ${ms} ms`);
        throw new APITimeoutError(timeout, { cause });
      }
      this.logger.info(`${tag} connection failed after ${ms} ms`, cause);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new APIConnectionError(`connection failed: ${reason}`, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  /** Waits out the delay before the next attempt; the caller's signal ends the wait. */
  async #pause({ tag, retry, signal }: Call, attempt: number, left: number, reason: string, headers?: Headers): Promise<void> {
    const ms = delay(attempt, retry, headers);
    this.logger.info(`${tag} retrying in ${ms} ms (${attempt + 1}/${attempt + left}) after ${reason}`);
    try {
      await sleep(ms, signal);
    } catch (cause) {
      this.logger.info(`${tag} aborted while waiting to retry`);
      throw new APIUserAbortError({ cause });
    }
  }
}
