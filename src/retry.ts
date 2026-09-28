import type { RetryPolicy } from "./types.js";

/** The policy every client starts from. */
export const RETRY: RetryPolicy = {
  maxRetries: 2,
  backoffInitialMs: 500,
  backoffMaxMs: 8_000,
  backoffJitter: 0.25,
  httpStatuses: new Set([408, 409, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)]),
  respectRetryAfter: true,
  maxRetryAfterMs: 60_000,
  apiConnectionError: true,
  apiTimeoutError: true,
};

/** Milliseconds the server asked to wait: retry-after-ms, else Retry-After in seconds or as an HTTP date. */
export function after(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms")?.trim();
  if (ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Milliseconds before retry `attempt + 1`: the server's ask capped at `maxRetryAfterMs`, else jittered exponential backoff. */
export function delay(attempt: number, policy: RetryPolicy, headers?: Headers): number {
  if (policy.respectRetryAfter && headers) {
    const asked = after(headers);
    if (asked !== undefined) return Math.min(asked, policy.maxRetryAfterMs);
  }
  const backoff = Math.min(policy.backoffInitialMs * 2 ** attempt, policy.backoffMaxMs);
  return Math.round(backoff * (1 - Math.random() * policy.backoffJitter));
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const stop = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}
