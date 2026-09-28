import { record } from "./json.js";
import { after } from "./retry.js";

/** Base of every error this client throws. */
export class KaiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server's sentence, from any error body the gateway or the decision runtime sends. */
function sentence(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, 500) || undefined;
  if (!record(body)) return undefined;
  const { error, msg, message } = body;
  if (record(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (typeof msg === "string") return msg;
  if (typeof message === "string") return message;
  return undefined;
}

function code(body: unknown): string | number | undefined {
  const c = record(body) && record(body.error) ? body.error.code : undefined;
  return typeof c === "string" || typeof c === "number" ? c : undefined;
}

/** A response with a status outside 2xx. */
export class APIError extends KaiError {
  readonly status: number;
  /** `error.code` from the body, when it has one. */
  readonly code: string | number | undefined;
  /** From `x-request-id`. */
  readonly requestId: string | undefined;
  /** Parsed JSON, the text when not JSON, or undefined when empty. */
  readonly body: unknown;
  /** Seconds the server asked to wait, from retry-after-ms or Retry-After. */
  readonly retryAfter: number | undefined;
  readonly headers: Headers;

  constructor(status: number, body: unknown, headers: Headers) {
    super(sentence(body) ?? `HTTP ${status}`);
    this.status = status;
    this.code = code(body);
    this.requestId = headers.get("x-request-id") ?? undefined;
    this.body = body;
    const ms = after(headers);
    this.retryAfter = ms === undefined ? undefined : ms / 1000;
    this.headers = headers;
  }

  /** The error class for a status. */
  static from(status: number, body: unknown, headers: Headers): APIError {
    if (status === 400) return new BadRequestError(status, body, headers);
    if (status === 401) return new AuthenticationError(status, body, headers);
    if (status === 402) return new PaymentRequiredError(status, body, headers);
    if (status === 403) return new PermissionDeniedError(status, body, headers);
    if (status === 404) return new NotFoundError(status, body, headers);
    if (status === 422) return new UnprocessableEntityError(status, body, headers);
    if (status === 429) return new RateLimitError(status, body, headers);
    if (status >= 500) return new InternalServerError(status, body, headers);
    return new APIError(status, body, headers);
  }
}

/** 400: the request is malformed; the message names what to fix. */
export class BadRequestError extends APIError {}
/** 401: the key is missing, wrong or revoked. */
export class AuthenticationError extends APIError {}
/** 402: no plan or no balance. */
export class PaymentRequiredError extends APIError {}
/** 403: the key may not do this; a publishable key cannot decide. */
export class PermissionDeniedError extends APIError {}
/** 404: no such route or resource. */
export class NotFoundError extends APIError {}
/** 422: well formed, but the options do not fit the model's window. */
export class UnprocessableEntityError extends APIError {}
/** 429: too many requests; `retryAfter` says how long to wait. */
export class RateLimitError extends APIError {}
/** 500 and above: the server or its upstream failed. */
export class InternalServerError extends APIError {}

/** No response arrived: DNS, TLS, a dropped connection, or a body cut short. */
export class APIConnectionError extends KaiError {
  constructor(message = "connection failed", options?: ErrorOptions) {
    super(message, options);
  }
}

/** An attempt, body included, outlasted its timeout. */
export class APITimeoutError extends APIConnectionError {
  /** The timeout that elapsed, in ms. */
  readonly timeout: number;

  constructor(timeout: number, options?: ErrorOptions) {
    super(`request timed out after ${timeout} ms`, options);
    this.timeout = timeout;
  }
}

/** The caller's signal aborted the request. */
export class APIUserAbortError extends KaiError {
  constructor(options?: ErrorOptions) {
    super("request aborted", options);
  }
}
