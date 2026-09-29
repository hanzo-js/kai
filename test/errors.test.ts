import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  Kai,
  KaiError,
  NotFoundError,
  noul,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@hanzo/kai";
import { scripted } from "./fetch.ts";

/** The error a decide call rejects with when the server answers `status` with `body`. */
async function failure(status: number, body: string, headers: Record<string, string> = {}): Promise<APIError> {
  const { fetch } = scripted(() => new Response(body, { status, headers }));
  const kai = new Kai({ apiKey: "sk-test", fetch, retry: { maxRetries: 0 } });
  const error = await kai.decide({ state: "s", questions: { q: noul("q?") } }).catch((e: unknown) => e);
  assert.ok(error instanceof APIError, `status ${status} rejected with ${String(error)}`);
  return error;
}

const JSON_TYPE = { "content-type": "application/json" };

test("every status maps to its class, carrying the server's sentence", async () => {
  const cases: [number, typeof APIError][] = [
    [400, BadRequestError],
    [401, AuthenticationError],
    [402, PaymentRequiredError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [422, UnprocessableEntityError],
    [429, RateLimitError],
    [500, InternalServerError],
    [502, InternalServerError],
    [503, InternalServerError],
    [409, APIError],
    [418, APIError],
  ];
  for (const [status, kind] of cases) {
    const sentence = `status ${status} said this`;
    const error = await failure(status, JSON.stringify({ error: { code: status, message: sentence } }), JSON_TYPE);
    assert.equal(error.constructor, kind);
    assert.equal(error.name, kind.name);
    assert.ok(error instanceof KaiError);
    assert.ok(error instanceof Error);
    assert.equal(error.status, status);
    assert.equal(error.message, sentence);
    assert.equal(error.code, status);
  }
});

test("the runtime's body: a 400 names what to fix", async () => {
  const body = { error: { code: 400, message: "question 'q': no 'instructions'; add the text the model should answer" } };
  const error = await failure(400, JSON.stringify(body), { ...JSON_TYPE, "x-request-id": "94d45fdb" });
  assert.ok(error instanceof BadRequestError);
  assert.equal(error.message, "question 'q': no 'instructions'; add the text the model should answer");
  assert.equal(error.code, 400);
  assert.equal(error.requestId, "94d45fdb");
  assert.deepEqual(error.body, body);
  assert.equal(error.retryAfter, undefined);
  assert.equal(error.headers.get("x-request-id"), "94d45fdb");
  assert.equal(String(error), "BadRequestError: question 'q': no 'instructions'; add the text the model should answer");
});

test("the runtime's body: a 422 when the options overflow the window", async () => {
  const body = { error: { code: 422, message: "question 'c' options exceed head_max_len=16" } };
  const error = await failure(422, JSON.stringify(body), JSON_TYPE);
  assert.ok(error instanceof UnprocessableEntityError);
  assert.equal(error.message, "question 'c' options exceed head_max_len=16");
});

test("the gateway's bodies: error with message, type and code; status and msg", async () => {
  const paid = await failure(
    402,
    JSON.stringify({ error: { message: "insufficient balance; add funds", type: "billing_error", code: "insufficient_balance" } }),
    JSON_TYPE,
  );
  assert.ok(paid instanceof PaymentRequiredError);
  assert.equal(paid.message, "insufficient balance; add funds");
  assert.equal(paid.code, "insufficient_balance");

  const nokey = await failure(
    401,
    JSON.stringify({ status: "error", msg: "API key validation failed: API key sk-not-a-… does not resolve", data: null }),
    { ...JSON_TYPE, "x-request-id": "04df3de9" },
  );
  assert.ok(nokey instanceof AuthenticationError);
  assert.equal(nokey.message, "API key validation failed: API key sk-not-a-… does not resolve");
  assert.equal(nokey.code, undefined);
  assert.equal(nokey.requestId, "04df3de9");

  const publishable = await failure(403, JSON.stringify({ status: "error", msg: "publishable keys cannot call this" }), JSON_TYPE);
  assert.ok(publishable instanceof PermissionDeniedError);
  assert.equal(publishable.message, "publishable keys cannot call this");
});

test("a 429 carries Retry-After as seconds", async () => {
  const limited = await failure(429, JSON.stringify({ error: { message: "rate limited", type: "rate_limit", code: 429 } }), {
    ...JSON_TYPE,
    "retry-after": "7",
  });
  assert.ok(limited instanceof RateLimitError);
  assert.equal(limited.retryAfter, 7);
  const precise = await failure(429, "", { "retry-after-ms": "1500", "retry-after": "7" });
  assert.equal(precise.retryAfter, 1.5);
});

test("bodies that are not JSON: text becomes the message, an empty body names the status", async () => {
  const html = await failure(502, "<html>bad gateway</html>", { "content-type": "text/html" });
  assert.ok(html instanceof InternalServerError);
  assert.equal(html.body, "<html>bad gateway</html>");
  assert.equal(html.message, "<html>bad gateway</html>");
  const empty = await failure(503, "");
  assert.equal(empty.body, undefined);
  assert.equal(empty.message, "HTTP 503");
  const untyped = await failure(400, JSON.stringify({ error: { message: "json without a content type" } }));
  assert.deepEqual(untyped.body, { error: { message: "json without a content type" } });
  assert.equal(untyped.message, "json without a content type");
  const plain = await failure(400, JSON.stringify({ error: "a plain string" }));
  assert.equal(plain.message, "a plain string");
  const shapeless = await failure(400, JSON.stringify({ detail: [1] }));
  assert.equal(shapeless.message, "HTTP 400");
});

test("the compatible path's FastAPI bodies: a detail list, or a detail sentence", async () => {
  const invalid = await failure(
    422,
    JSON.stringify({
      detail: [
        { loc: ["body", "questions", "q", "criteria"], msg: "Input should be a valid list", type: "list_type" },
        { loc: ["body", "state"], msg: "Field required", type: "missing" },
      ],
    }),
    { ...JSON_TYPE, "x-request-id": "req_422" },
  );
  assert.ok(invalid instanceof UnprocessableEntityError);
  assert.equal(invalid.message, "questions.q.criteria: Input should be a valid list; state: Field required");
  assert.equal(invalid.code, "list_type");
  assert.equal(invalid.requestId, "req_422");
  const unknown = await failure(400, JSON.stringify({ detail: "Unknown model: jev-latest" }), JSON_TYPE);
  assert.ok(unknown instanceof BadRequestError);
  assert.equal(unknown.message, "Unknown model: jev-latest");
  assert.equal(unknown.code, undefined);
  const unpaid = await failure(402, JSON.stringify({ detail: "insufficient balance" }), JSON_TYPE);
  assert.ok(unpaid instanceof PaymentRequiredError);
  assert.equal(unpaid.message, "insufficient balance");
});

test("a state past what the model reads: 422 with code state_too_long", async () => {
  const body = { error: { code: "state_too_long", message: "the state and a question need 9120 tokens; kai reads 8192" } };
  const error = await failure(422, JSON.stringify(body), JSON_TYPE);
  assert.ok(error instanceof UnprocessableEntityError);
  assert.equal(error.code, "state_too_long");
  assert.equal(error.message, "the state and a question need 9120 tokens; kai reads 8192");
});

test("a 529 is a server error that says when to come back", async () => {
  const error = await failure(529, JSON.stringify({ error: { code: 529, message: "overloaded" } }), {
    ...JSON_TYPE,
    "retry-after": "2",
    "retry-after-ms": "1500",
  });
  assert.ok(error instanceof InternalServerError);
  assert.equal(error.message, "overloaded");
  assert.equal(error.retryAfter, 1.5);
});

test("a refusal over reach names what is over in code, on either path's body", async () => {
  const reach: [string, string, (string | number)[]][] = [
    ["state_too_long", "the state takes 131073 tokens; the wire carries at most 131072", ["body", "state"]],
    ["question_too_long", 'question "q" takes 700 tokens with its type line; kai-a211cc701038 reads at most 512', ["body", "questions", "q", "noul", "instructions"]],
    ["option_too_long", 'option "a" of question "q" takes 900 tokens; kai-a211cc701038 reads an option whole up to 512', ["body", "questions", "q", "choice", "criteria", "a"]],
    ["request_too_long", "the body is over 16777216 bytes", ["body"]],
  ];
  for (const [name, message, loc] of reach) {
    const native = await failure(422, JSON.stringify({ error: { code: name, message } }), JSON_TYPE);
    assert.ok(native instanceof UnprocessableEntityError);
    assert.equal(native.code, name);
    assert.equal(native.message, message);
    const compat = await failure(422, JSON.stringify({ detail: [{ loc, msg: message, type: name }] }), JSON_TYPE);
    assert.ok(compat instanceof UnprocessableEntityError);
    assert.equal(compat.code, name);
    const where = loc.slice(1).join(".");
    assert.equal(compat.message, where ? `${where}: ${message}` : message);
  }
});
