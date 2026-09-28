// @hanzo/kai/jev: the Jev-compatible layer. A TypeSafe program ports by changing its import:
//   import { choice, noul, score, Client as TypeSafeClient } from "@hanzo/kai/jev";
import { answered } from "./client.js";
import { ENV as ALL } from "./env.js";
import { KaiError } from "./errors.js";
import { Http, settings } from "./http.js";
import { record } from "./json.js";
import type { APIPromise } from "./promise.js";
import { check } from "./questions.js";
import type {
  ChoiceAnswer,
  ChoiceCriteria,
  ChoiceQuestion,
  Config as Native,
  DecisionRequest,
  Fetch,
  Logger,
  LogLevel,
  NoulAnswer,
  NoulQuestion,
  Question,
  Questions,
  RequestOptions,
  RetryPolicy,
  ScoreAnswer,
  ScoreCriteria,
  ScoreQuestion,
  Usage,
} from "./types.js";

export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  KaiError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "./errors.js";
export { LOG_LEVELS } from "./log.js";
export { APIPromise, type WithResponse } from "./promise.js";
export { choice, noul, score } from "./questions.js";
export type {
  ChoiceCriteria,
  ChoiceQuestion,
  DecisionRequest,
  Description,
  EntryType,
  Fetch,
  JsonValue,
  Logger,
  LogLevel,
  NoulQuestion,
  Question,
  Questions,
  RequestOptions,
  RetryPolicy,
  ScoreCriteria,
  ScoreLegend,
  ScoreOf,
  ScoreQuestion,
  Usage,
} from "./types.js";
export { VERSION } from "./version.js";

/** The environment variables this client reads for settings it was not given. */
export const ENV: Pick<typeof ALL, "apiKey" | "baseURL" | "logLevel"> = {
  apiKey: ALL.apiKey,
  baseURL: ALL.baseURL,
  logLevel: ALL.logLevel,
};

export type EnvVar = (typeof ENV)[keyof typeof ENV];

/** Client settings: the native client's, with the model named `defaultModel`. */
export interface Config extends Omit<Native, "model"> {
  /** Model for calls that name none. Default kai, the one model /v1/systemone answers. */
  defaultModel?: string;
}

/** P(true), and nothing else, as Jev answers a noul. */
export type NoulResponse = Pick<NoulAnswer, "type" | "noul">;

/** The chosen label, its confidence and every label's probability. */
export type ChoiceResponse<T extends ChoiceCriteria = ChoiceCriteria> = Pick<
  ChoiceAnswer<T>,
  "type" | "choice" | "confidence" | "probabilities"
>;

/** The expected level, its confidence, the levels' descriptions and probabilities. */
export type ScoreResponse<T extends ScoreCriteria = ScoreCriteria> = Pick<
  ScoreAnswer<T>,
  "type" | "score" | "confidence" | "legend" | "probabilities"
>;

/** The response type a question gets back, its labels and levels kept. */
export type ResultFor<T extends Question> = T extends NoulQuestion
  ? NoulResponse
  : T extends ChoiceQuestion<infer C>
    ? ChoiceResponse<C>
    : T extends ScoreQuestion<infer S>
      ? ScoreResponse<S>
      : never;

/** Answers typed by question, the model that gave them, and the tokens billed. */
export interface Result<Q extends Questions = Questions> {
  /** Kai's versioned id. */
  readonly model: string;
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  readonly usage: Usage;
}

/** A decision model as GET /v1/models lists it under `models`. */
export interface ModelCard {
  readonly name: string;
  readonly description: string;
  readonly release_date: string;
}

/** The models resource. */
export interface Models {
  /** The `models` list of GET /v1/models. */
  list(options?: RequestOptions): APIPromise<ModelCard[]>;
}

function cards(data: unknown): ModelCard[] {
  if (!record(data) || !Array.isArray(data.models)) throw new KaiError("GET /v1/models answered without a 'models' list");
  return data.models.filter((m): m is ModelCard => record(m));
}

/** Client for POST /v1/systemone, the path that answers as Jev does. */
export class Client {
  readonly #http: Http;
  /** API root, trailing slashes removed. */
  readonly baseURL: string;
  /** Model for calls that name none. */
  readonly defaultModel: string;
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
   * Each setting comes from `config`, else HANZO_API_KEY, HANZO_BASE_URL and KAI_LOG_LEVEL, else its default.
   *
   * @throws {KaiError} No API key, a setting out of range, no fetch, or a browser page without `dangerouslyAllowBrowser`.
   */
  constructor(config: Config = {}) {
    const s = settings(config);
    this.#http = new Http(s);
    this.baseURL = s.baseURL;
    this.defaultModel = config.defaultModel ?? "kai";
    this.timeout = s.timeout;
    this.retry = s.retry;
    this.defaultHeaders = s.defaultHeaders;
    this.logLevel = s.logLevel;
    this.logger = s.logger;
    this.fetch = s.fetch;
    this.models = {
      list: (options = {}) => this.#http.send("GET", "/v1/models", options, undefined, cards),
    };
  }

  /**
   * Ask questions about a state and get Jev's answer shapes, each typed by its question.
   *
   * @throws {KaiError} No questions, or criteria of the wrong shape; thrown before anything is sent.
   */
  systemOne<const Q extends Questions>(request: DecisionRequest<Q>, options: RequestOptions = {}): APIPromise<Result<Q>> {
    check(request.questions);
    const { model, ...rest } = request;
    return this.#http.send(
      "POST",
      "/v1/systemone",
      options,
      { model: model ?? this.defaultModel, ...rest },
      (data) => answered(data, this.logger, "POST /v1/systemone") as unknown as Result<Q>,
    );
  }
}
