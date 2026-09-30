import type { APIPromise } from "./promise.js";

/** Any JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Text, a JSON object or a JSON array: what state, instructions and descriptions carry. */
export type EntryType = string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What an option means; `null` leaves a choice label undescribed. */
export type Description = EntryType | null;

/** The words a noul's two sides go by in the text Kai reads; their meaning stays yes and no. */
export interface NoulLabels {
  readonly true: string;
  readonly false: string;
}

/** A yes/no question: `noul` answers P(true). */
export interface NoulQuestion {
  readonly type: "noul";
  /** The question or statement Kai judges; optional. */
  readonly instructions?: EntryType | null;
  /** What true and what false mean; either side, both, or neither. */
  readonly criteria?: { readonly true?: Description; readonly false?: Description } | null;
  /** Words for the two sides, as `{ true: "refund", false: "no refund" }`; /v1/decisions only. */
  readonly labels?: NoulLabels;
}

/** Choice labels, at least two: a map of label to description, or a list of labels. */
export type ChoiceCriteria = { readonly [label: string]: Description } | readonly string[];

/** One label of several. */
export interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  readonly instructions?: EntryType | null;
  readonly criteria: T;
}

/** Score levels, lowest first, at least one; each level needs a description. */
export type ScoreCriteria = readonly [EntryType, ...EntryType[]];

/** One level of an ordered scale. */
export interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: "score";
  readonly instructions?: EntryType | null;
  readonly criteria: T;
}

/** A question, told apart by `type`. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Questions by the name their answers come back under. */
export interface Questions {
  readonly [name: string]: Question;
}

/** The labels of a choice: a map's keys or a list's entries. */
type Label<T extends ChoiceCriteria> = T extends readonly string[] ? T[number] : keyof T & string;

/** Probability that acting on an answer beats escalating it, when the model reports one. */
export interface Action {
  readonly act_probability: number;
}

/** P(true) for a yes/no question. */
export interface NoulAnswer {
  readonly type: "noul";
  /** Probability the statement holds, 0 to 1. */
  readonly noul: number;
  /** |2p − 1|: 0 at even odds, 1 when certain. */
  readonly confidence?: number;
  /** Calibrated probability of the more likely side. */
  readonly answer_confidence?: number;
  readonly action?: Action;
}

/** The chosen label and every label's probability. */
export interface ChoiceAnswer<T extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  readonly choice: Label<T>;
  /** (n·p_max − 1)/(n − 1): 0 when every label is equally likely, 1 when one takes all. */
  readonly confidence: number;
  readonly probabilities: { readonly [L in Label<T>]: number };
  /** Calibrated probability of the chosen label. */
  readonly answer_confidence?: number;
  readonly action?: Action;
}

/** Level keys of a score: "0", "1", … for a literal list, any number otherwise. */
export type ScoreOf<T extends ScoreCriteria> = number extends T["length"]
  ? number
  : Extract<keyof T, `${number}`>;

/** Each level's description, keyed by level. */
export type ScoreLegend<T extends ScoreCriteria> = { readonly [K in ScoreOf<T>]: T[K] };

/** The expected level and every level's probability. */
export interface ScoreAnswer<T extends ScoreCriteria = ScoreCriteria> {
  readonly type: "score";
  /** Expected level, Σ i·p_i; may fall between levels. */
  readonly score: number;
  /** (n·p_max − 1)/(n − 1) over the levels. */
  readonly confidence: number;
  readonly legend: ScoreLegend<T>;
  readonly probabilities: { readonly [K in ScoreOf<T>]: number };
  /** Calibrated probability of the most likely level. */
  readonly answer_confidence?: number;
  readonly action?: Action;
}

/** Any answer. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type a question gets back, its labels and levels kept. */
export type ResultFor<T extends Question> = T extends NoulQuestion
  ? NoulAnswer
  : T extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<C>
    : T extends ScoreQuestion<infer S>
      ? ScoreAnswer<S>
      : never;

/** Tokens a decision read and wrote; `cost` in USD when the gateway reports it. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost?: number;
}

/** Which model and weights answered, and why. */
export interface Routing {
  readonly backend: string;
  readonly checkpoint: string;
  readonly revision?: string;
  readonly sha256?: string;
  readonly calibration?: string;
  readonly device?: string;
  readonly upstream?: string;
  readonly reason: string;
}

/** A decision: every answer typed by the question that asked it. */
export interface Decision<Q extends Questions = Questions> {
  /** `dec_` and 32 hex digits. */
  readonly id: string;
  /** The model as asked. */
  readonly model: string;
  readonly provider: string;
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> };
  readonly usage: Usage;
  readonly routing: Routing;
  /** `sha256:` of the state as the model read it. */
  readonly state_hash: string;
  readonly latency_ms: number;
}

/** State, the questions to ask about it, and optional request fields. Other fields are sent as given. */
export interface DecisionRequest<Q extends Questions = Questions> {
  /** Text, a JSON object or a JSON array. */
  state: EntryType;
  /** At least one question. */
  questions: Q;
  /** Overrides the client's model. */
  model?: string;
  session_id?: string;
  user?: string;
  trace?: JsonValue;
  provider?: JsonValue;
}

/** A model's list prices in US dollars. */
export interface Pricing {
  /** Per input token, as a decimal string (OpenRouter's key and unit). */
  readonly prompt: string;
  /** Per output token, as a decimal string. */
  readonly completion: string;
  readonly input_per_million: number;
  readonly output_per_million: number;
}

/** A model that answers decisions. */
export interface Model {
  readonly id: string;
  readonly owned_by: string;
  /** Unix seconds. */
  readonly created: number;
  /** List prices in USD, per token and per million tokens. */
  readonly pricing: Pricing;
}

/** The models resource. */
export interface Models {
  /** Models whose outputs include "decision", from GET /v1/models. */
  list(options?: RequestOptions): APIPromise<Model[]>;
}

/** Retry settings; a partial policy on the client or a call fills in the rest from the defaults. */
export interface RetryPolicy {
  /** Retries after the first attempt; 0 turns retries off. Default 2. */
  readonly maxRetries: number;
  /** First backoff in ms, doubled per retry up to `backoffMaxMs`. Default 500. */
  readonly backoffInitialMs: number;
  /** Longest backoff in ms. Default 8000. */
  readonly backoffMaxMs: number;
  /** Largest fraction taken off a backoff at random, 0 to 1. Default 0.25. */
  readonly backoffJitter: number;
  /** Statuses that are retried. Default 408, 409, 429 and 500–599. */
  readonly httpStatuses: ReadonlySet<number>;
  /** Wait as long as Retry-After or retry-after-ms asks, up to `maxRetryAfterMs`. Default true. */
  readonly respectRetryAfter: boolean;
  /** Longest server-requested wait in ms. Default 60000. */
  readonly maxRetryAfterMs: number;
  /** Retry an `APIConnectionError`. Default true. */
  readonly apiConnectionError: boolean;
  /** Retry an `APITimeoutError`. Default true. */
  readonly apiTimeoutError: boolean;
}

/** Per-call settings; each overrides the client's. */
export interface RequestOptions {
  /** Aborts the request and any wait before a retry. */
  signal?: AbortSignal;
  /** Milliseconds per attempt, body included. */
  timeout?: number;
  retry?: Partial<RetryPolicy>;
  /** Added to the client's `defaultHeaders`, winning on a clash. */
  headers?: Record<string, string>;
}

/** A fetch the client can call in place of the global one. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Log verbosity; `off` logs nothing. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

/** Where log lines go; `console` fits. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Client settings; each falls back to its environment variable, then its default. */
export interface Config {
  /** Hanzo API key; else HANZO_API_KEY. */
  apiKey?: string;
  /** API root; else HANZO_BASE_URL, else https://api.hanzo.ai. */
  baseURL?: string;
  /** Model for calls that name none; else KAI_MODEL, else kai. */
  model?: string;
  /** Milliseconds per attempt. Default 60000. */
  timeout?: number;
  retry?: Partial<RetryPolicy>;
  /** Sent with every request. */
  defaultHeaders?: Record<string, string>;
  fetch?: Fetch;
  logger?: Logger;
  /** Else KAI_LOG_LEVEL, else warn. `info` logs one line per attempt; `debug` adds headers, credentials masked, and bodies. */
  logLevel?: LogLevel;
  /** Run in a browser page, where anyone using the page can read the key. Default false. */
  dangerouslyAllowBrowser?: boolean;
}
