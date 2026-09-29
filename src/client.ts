import { ENV, env } from "./env.js";
import { KaiError } from "./errors.js";
import { Http, settings } from "./http.js";
import { record } from "./json.js";
import type { APIPromise } from "./promise.js";
import { check } from "./questions.js";
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

/** The body with only the answers whose type this client knows, warning about each one it drops. */
export function answered(data: unknown, logger: Logger, route: string): Record<string, unknown> {
  if (!record(data) || !record(data.answers)) throw new KaiError(`${route} answered without an 'answers' object`);
  const answers: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(data.answers)) {
    const type = record(answer) ? answer.type : undefined;
    if (type === "noul" || type === "choice" || type === "score") answers[name] = answer;
    else logger.warn(`answer "${name}" has type ${JSON.stringify(type)}, which this client does not know; skipped`);
  }
  return { ...data, answers };
}

/** The models of a GET /v1/models body whose outputs include "decision". */
export function catalog(data: unknown): Model[] {
  if (!record(data) || !Array.isArray(data.data)) throw new KaiError("GET /v1/models answered without a 'data' list");
  return data.data.filter(
    (m): m is Model => record(m) && Array.isArray(m.outputs) && m.outputs.includes("decision"),
  );
}

/** Client for Kai decisions on api.hanzo.ai. */
export class Kai {
  readonly #http: Http;
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

  /**
   * Each setting comes from `config`, else its environment variable, else its default.
   *
   * @throws {KaiError} No API key, a setting out of range, no fetch, or a browser page without `dangerouslyAllowBrowser`.
   */
  constructor(config: Config = {}) {
    const s = settings(config);
    this.#http = new Http(s);
    this.baseURL = s.baseURL;
    this.model = config.model ?? env(ENV.model) ?? "kai";
    this.timeout = s.timeout;
    this.retry = s.retry;
    this.defaultHeaders = s.defaultHeaders;
    this.logLevel = s.logLevel;
    this.logger = s.logger;
    this.fetch = s.fetch;
    this.models = {
      list: (options = {}) => this.#http.send("GET", "/v1/models", options, undefined, catalog),
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
    return this.#http.send(
      "POST",
      "/v1/decisions",
      options,
      { model: model ?? this.model, ...rest },
      (data) => answered(data, this.logger, "POST /v1/decisions") as unknown as Decision<Q>,
    );
  }
}
