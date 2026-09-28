import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  InternalServerError,
  Kai,
  KaiError,
  noul,
  RateLimitError,
} from "@hanzo/kai";
import type { Config } from "@hanzo/kai";
import { DECISION, flush, hang, json, MODELS, recorder, said, scripted } from "./fetch.ts";

const QUESTIONS = { q: noul("q?") };
const NOW = { maxRetries: 2, backoffInitialMs: 0, backoffMaxMs: 0 };

/** Answers `first` in order, then 200. */
function then200(...first: (Response | Error)[]) {
  return scripted((_, n) => {
    const step = first[n];
    if (step instanceof Error) throw step;
    return step ?? json(DECISION);
  });
}

function kai(fetch: Config["fetch"], extra: Config = {}): Kai {
  return new Kai({ apiKey: "sk-test", fetch, ...extra });
}

/** Settles `p` while firing each mocked timer as soon as the client has scheduled it. */
async function drive<T>(t: TestContext, p: Promise<T>): Promise<T> {
  const settled = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  for (let i = 0; i < 20; i++) {
    await flush();
    t.mock.timers.runAll();
  }
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

/** The waits the client logged, in ms. */
function waits(log: ReturnType<typeof recorder>): number[] {
  return said(log, "info")
    .map((m) => /retrying in (\d+) ms/.exec(m)?.[1])
    .filter((m) => m !== undefined)
    .map(Number);
}

test("the default policy: 2 retries, 0.5 s doubling to 8 s less up to 25%, 408 409 429 5xx, Retry-After up to 60 s", () => {
  const client = new Kai({ apiKey: "sk-test" });
  assert.deepEqual(client.retry, {
    maxRetries: 2,
    backoffInitialMs: 500,
    backoffMaxMs: 8000,
    backoffJitter: 0.25,
    httpStatuses: new Set([408, 409, 429, ...Array.from({ length: 100 }, (_, i) => 500 + i)]),
    respectRetryAfter: true,
    maxRetryAfterMs: 60000,
    apiConnectionError: true,
    apiTimeoutError: true,
  });
  assert.equal(client.timeout, 60000);
});

test("408, 409, 429 and 5xx are retried", async () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504, 599]) {
    const { fetch, calls } = then200(json({ error: { code: status, message: "again" } }, status));
    const d = await kai(fetch, { retry: NOW }).decide({ state: "s", questions: QUESTIONS });
    assert.equal(d.id, DECISION.id);
    assert.equal(calls.length, 2, `status ${status}`);
  }
});

test("400, 401, 402, 403, 404 and 422 are not retried", async () => {
  for (const status of [400, 401, 402, 403, 404, 422]) {
    const { fetch, calls } = then200(json({ error: { code: status, message: "no" } }, status));
    const error = await kai(fetch, { retry: NOW }).decide({ state: "s", questions: QUESTIONS }).catch((e: unknown) => e);
    assert.ok(error instanceof APIError && error.status === status);
    assert.equal(calls.length, 1, `status ${status}`);
  }
});

test("after the last retry the last error is thrown", async () => {
  const { fetch, calls } = scripted(() => json({ error: { code: 503, message: "down" } }, 503));
  const error = await kai(fetch, { retry: { ...NOW, maxRetries: 3 } })
    .decide({ state: "s", questions: QUESTIONS })
    .catch((e: unknown) => e);
  assert.ok(error instanceof InternalServerError);
  assert.equal(error.message, "down");
  assert.equal(calls.length, 4);
});

test("each retry says which it is in X-Kai-Retry-Count", async () => {
  const { fetch, calls } = then200(json({}, 503), json({}, 502));
  await kai(fetch, { retry: NOW }).decide({ state: "s", questions: QUESTIONS });
  assert.deepEqual(
    calls.map((c) => c.headers.get("x-kai-retry-count")),
    [null, "1", "2"],
  );
});

test("Retry-After in seconds is waited out exactly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetch, calls } = scripted((_, n) => (n === 0 ? json({}, 429, { "retry-after": "2" }) : json(MODELS)));
  const p = kai(fetch).models.list();
  const settled = p.then((models) => models.map((m) => m.id));
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(await settled, ["hanzo/kai", "kai"]);
});

test("retry-after-ms wins over Retry-After, and an HTTP date counts from now", async (t) => {
  const now = 1_790_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  t.mock.method(Math, "random", () => 0);
  const log = recorder();
  const { fetch } = scripted((_, n) =>
    n === 0
      ? json({}, 503, { "retry-after-ms": "250", "retry-after": "3" })
      : n === 1
        ? json({}, 503, { "retry-after": new Date(now + 5000).toUTCString() })
        : json({}, 503, { "retry-after": "soon" }),
  );
  const client = kai(fetch, { logger: log, logLevel: "info", retry: { maxRetries: 3 } });
  await assert.rejects(drive(t, client.models.list()), InternalServerError);
  // 250 ms passed before the date was read, so 4750 remain; "soon" is no delay at all, so backoff.
  assert.deepEqual(waits(log), [250, 4750, 2000]);
});

test("a 529 is retried after the wait it asks for, like a 429", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { fetch, calls } = scripted((_, n) =>
    n === 0 ? json({ error: { code: 529, message: "overloaded" } }, 529, { "retry-after-ms": "1500", "retry-after": "2" }) : json(MODELS),
  );
  const settled = kai(fetch).models.list().then((models) => models.length);
  await flush();
  t.mock.timers.tick(1499);
  await flush();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.headers.get("x-kai-retry-count"), "1");
  assert.equal(await settled, 2);
});

test("a server wait over the cap is capped, per client or per call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = recorder();
  const { fetch } = scripted(() => json({}, 429, { "retry-after": "120" }));
  const client = kai(fetch, { logger: log, logLevel: "info", retry: { maxRetries: 1 } });
  await assert.rejects(drive(t, client.models.list()), RateLimitError);
  await assert.rejects(drive(t, client.models.list({ retry: { maxRetryAfterMs: 1000 } })), RateLimitError);
  assert.deepEqual(waits(log), [60000, 1000]);
});

test("with respectRetryAfter off, Retry-After is ignored for backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const log = recorder();
  const { fetch } = scripted(() => json({}, 429, { "retry-after": "30" }));
  const client = kai(fetch, { logger: log, logLevel: "info", retry: { maxRetries: 1, respectRetryAfter: false } });
  await assert.rejects(drive(t, client.models.list()), RateLimitError);
  assert.deepEqual(waits(log), [500]);
});

test("backoff doubles from 500 ms to 8 s, and jitter takes off at most a quarter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const random = t.mock.method(Math, "random", () => 0);
  const log = recorder();
  const { fetch, calls } = scripted(() => json({}, 503));
  const client = kai(fetch, { logger: log, logLevel: "info", retry: { maxRetries: 6 } });
  await assert.rejects(drive(t, client.models.list()), InternalServerError);
  assert.equal(calls.length, 7);
  assert.deepEqual(waits(log), [500, 1000, 2000, 4000, 8000, 8000]);
  random.mock.mockImplementation(() => 1);
  await assert.rejects(drive(t, client.models.list({ retry: { maxRetries: 2 } })), InternalServerError);
  assert.deepEqual(waits(log).slice(6), [375, 750]);
  assert.match(said(log, "info").find((m) => m.includes("retrying")) ?? "", /^#1 GET \/v1\/models retrying in 500 ms \(1\/6\) after 503$/);
});

test("connection errors are retried, unless apiConnectionError is off", async () => {
  const { fetch, calls } = then200(new TypeError("fetch failed"));
  const d = await kai(fetch, { retry: NOW }).decide({ state: "s", questions: QUESTIONS });
  assert.equal(d.id, DECISION.id);
  assert.equal(calls.length, 2);

  const cause = new TypeError("fetch failed");
  const once = then200(cause);
  const error = await kai(once.fetch, { retry: { ...NOW, apiConnectionError: false } })
    .decide({ state: "s", questions: QUESTIONS })
    .catch((e: unknown) => e);
  assert.ok(error instanceof APIConnectionError);
  assert.equal(error.message, "connection failed: fetch failed");
  assert.equal(error.cause, cause);
  assert.equal(once.calls.length, 1);
});

test("an attempt past its timeout is retried, then fails with APITimeoutError", async () => {
  const { fetch, calls } = scripted(() => hang());
  const error = await kai(fetch, { timeout: 20, retry: { ...NOW, maxRetries: 1 } })
    .decide({ state: "s", questions: QUESTIONS })
    .catch((e: unknown) => e);
  assert.ok(error instanceof APITimeoutError);
  assert.ok(error instanceof APIConnectionError);
  assert.equal(error.message, "request timed out after 20 ms");
  assert.equal(error.timeout, 20);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.signal?.aborted));

  const once = scripted(() => hang());
  await assert.rejects(
    kai(once.fetch, { retry: NOW }).models.list({ timeout: 20, retry: { apiTimeoutError: false } }),
    APITimeoutError,
  );
  assert.equal(once.calls.length, 1);
});

test("a body that stalls past the timeout counts as a timeout", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"object":"list",'));
    },
  });
  const { fetch } = scripted(() => new Response(stalled, { headers: { "content-type": "application/json" } }));
  await assert.rejects(kai(fetch, { timeout: 30, retry: { maxRetries: 0 } }).models.list(), APITimeoutError);
});

test("a call's retry policy overrides the client's", async () => {
  const { fetch, calls } = scripted(() => json({}, 503));
  const client = kai(fetch, { retry: { ...NOW, maxRetries: 5 } });
  await assert.rejects(client.decide({ state: "s", questions: QUESTIONS }, { retry: { maxRetries: 0 } }), InternalServerError);
  assert.equal(calls.length, 1);

  const teapot = then200(json({}, 418));
  await kai(teapot.fetch, { retry: NOW }).decide({ state: "s", questions: QUESTIONS }, { retry: { httpStatuses: new Set([418]) } });
  assert.equal(teapot.calls.length, 2);
  assert.equal(client.retry.maxRetries, 5);
});

test("a policy or timeout out of range is refused", () => {
  assert.throws(() => new Kai({ apiKey: "k", retry: { maxRetries: -1 } }), {
    name: "KaiError",
    message: "retry.maxRetries must be a whole number of zero or more, got -1",
  });
  assert.throws(() => new Kai({ apiKey: "k", retry: { maxRetries: 1.5 } }), KaiError);
  assert.throws(() => new Kai({ apiKey: "k", retry: { backoffJitter: 2 } }), /retry.backoffJitter must be from 0 to 1/);
  assert.throws(() => new Kai({ apiKey: "k", retry: { backoffMaxMs: Number.NaN } }), /retry.backoffMaxMs/);
  assert.throws(() => new Kai({ apiKey: "k", retry: { httpStatuses: new Set([42]) } }), /retry.httpStatuses must hold HTTP statuses/);
  assert.throws(() => new Kai({ apiKey: "k", retry: { respectRetryAfter: "yes" as never } }), /retry.respectRetryAfter/);
  assert.throws(() => new Kai({ apiKey: "k", timeout: 0 }), { message: "timeout must be more than zero milliseconds, got 0" });
  const client = new Kai({ apiKey: "k", fetch: scripted(() => json(MODELS)).fetch });
  assert.throws(() => client.models.list({ retry: { maxRetries: -1 } }), /retry.maxRetries/);
  assert.throws(() => client.models.list({ timeout: -5 }), /timeout must be more than zero/);
});

test("the client's status set is its own copy", async () => {
  const mine = new Set([503]);
  const { fetch, calls } = scripted(() => json({}, 503));
  const client = kai(fetch, { retry: { ...NOW, httpStatuses: mine, maxRetries: 1 } });
  mine.clear();
  await assert.rejects(client.models.list(), InternalServerError);
  assert.equal(calls.length, 2);
});

test("aborting during a request rejects with APIUserAbortError and is never retried", async () => {
  const controller = new AbortController();
  const { fetch, calls } = scripted(() => {
    setTimeout(() => controller.abort(), 5);
    return hang();
  });
  const error = await kai(fetch)
    .decide({ state: "s", questions: QUESTIONS }, { signal: controller.signal })
    .catch((e: unknown) => e);
  assert.ok(error instanceof APIUserAbortError);
  assert.equal(error.message, "request aborted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.signal?.aborted, true);
});

test("an aborted signal sends nothing", async () => {
  const { fetch, calls } = scripted(() => json(DECISION));
  await assert.rejects(
    kai(fetch).decide({ state: "s", questions: QUESTIONS }, { signal: AbortSignal.abort() }),
    APIUserAbortError,
  );
  assert.equal(calls.length, 0);
});

test("aborting during the wait before a retry rejects at once", async () => {
  const controller = new AbortController();
  const { fetch, calls } = scripted(() => {
    setTimeout(() => controller.abort(), 20);
    return json({}, 503);
  });
  const started = Date.now();
  await assert.rejects(
    kai(fetch, { retry: { backoffInitialMs: 10_000 } }).models.list({ signal: controller.signal }),
    APIUserAbortError,
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(calls.length, 1);
});
