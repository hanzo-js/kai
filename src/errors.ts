import { record } from "./json.js";
import { after } from "./retry.js";

/** Base of every error this client throws. */
export class KaiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** FastAPI validation items as "where: what", joined; the leading "body" of each location dropped. */
function items(detail: unknown[]): string | undefined {
  const parts = detail.flatMap((d) => {
    if (!record(d) || typeof d.msg !== "string") return [];
    const where = Array.isArray(d.loc) ? d.loc.filter((p, i) => !(i === 0 && p === "body")).join(".") : "";
    return [where ? `${where}: ${d.msg}` : d.msg];
  });
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/** The server's sentence, from any error body the gateway, the native path or the compatible path sends. */
function sentence(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, 500) || undefined;
  if (!record(body)) return undefined;
  const { error, msg, message, detail } = body;
  if (record(error) && typeof error.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (typeof msg === "string") return msg;
  if (typeof message === "string") return message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return items(detail);
  return undefined;
}

/** `error.code`, or the first FastAPI validation item's `type`. */
function code(body: unknown): string | number | undefined {
  if (!record(body)) return undefined;
  const first = Array.isArray(body.detail) ? body.detail[0] : undefined;
  const c = record(body.error) ? body.error.code : record(first) ? first.type : undefined;
  return typeof c === "string" || typeof c === "number" ? c : undefined;
}

/** A response with a status outside 2xx. */
export class APIError extends KaiError {
  readonly status: number;
  /** `error.code`, or a FastAPI body's first `type`: a status, or a word such as `state_too_long`. */
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

/** 400: malformed JSON or an unknown model. */
export class BadRequestError extends APIError {}
/** 401: the key is missing, wrong or revoked. */
export class AuthenticationError extends APIError {}
/** 402: insufficient balance. */
export class PaymentRequiredError extends APIError {}
/** 403: this kind of key may not call it, as a publishable `pk-` key. */
export class PermissionDeniedError extends APIError {}
/** 404: no such route or resource. */
export class NotFoundError extends APIError {}
/** 422: a request outside the schema, or a state past what the model reads (`code` `state_too_long`). */
export class UnprocessableEntityError extends APIError {}
/** 429: rate limited or the queue is full; `retryAfter` says how long to wait. */
export class RateLimitError extends APIError {}
/** 500 and above: failed upstream (502), not served here (503), overloaded (529, with `retryAfter`). */
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
