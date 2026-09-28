import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  choice,
  Client as TypeSafeClient,
  ENV,
  noul,
  RateLimitError,
  score,
  UnprocessableEntityError,
  VERSION,
} from "@hanzo/kai/jev";
import { json, recorder, said, scripted } from "./fetch.ts";

const RESULT = {
  model: "kai-a7",
  answers: {
    refund: { type: "noul", noul: 0.8114 },
    team: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.95, tech: 0.05 } },
    urgency: {
      type: "score",
      score: 1.2,
      confidence: 0.4,
      legend: { "0": "can wait", "1": "this week", "2": "today" },
      probabilities: { "0": 0.2, "1": 0.4, "2": 0.4 },
    },
  },
  usage: { input_tokens: 64, output_tokens: 0 },
};

const QUESTIONS = {
  refund: noul("The customer asks for money back."),
  team: choice("Which team?", { billing: "charges", tech: "bugs" }),
  urgency: score("How urgent?", ["can wait", "this week", "today"]),
};

const saved = { ...process.env };

beforeEach(() => {
  for (const name of ["HANZO_API_KEY", "HANZO_BASE_URL", "KAI_MODEL", "KAI_LOG_LEVEL"]) delete process.env[name];
});

afterEach(() => {
  process.env = { ...saved };
});

test("a TypeSafe program ports by its import: systemOne posts to /v1/systemone with model kai", async () => {
  const { fetch, calls } = scripted(() => json(RESULT, 200, { "x-request-id": "req_jev" }));
  const client = new TypeSafeClient({ apiKey: "sk-test", baseURL: "https://api.test", fetch });
  const { data, requestId } = await client.systemOne({ state: { ticket: "charged twice" }, questions: QUESTIONS }).withResponse();
  assert.equal(calls[0]?.url, "https://api.test/v1/systemone");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(calls[0]?.body, { model: "kai", state: { ticket: "charged twice" }, questions: QUESTIONS });
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-test");
  assert.equal(calls[0]?.headers.get("user-agent"), `@hanzo/kai/${VERSION}`);
  assert.equal(requestId, "req_jev");
  assert.equal(data.model, "kai-a7");
  assert.equal(data.answers.refund.noul, 0.8114);
  assert.equal(data.answers.team.choice, "billing");
  assert.equal(data.answers.team.probabilities.tech, 0.05);
  assert.equal(data.answers.urgency.legend[2], "today");
  assert.equal(data.answers.urgency.probabilities[1], 0.4);
  assert.deepEqual(data.usage, { input_tokens: 64, output_tokens: 0 });
});

test("defaultModel names the model; a call's model wins", async () => {
  const { fetch, calls } = scripted(() => json(RESULT));
  const client = new TypeSafeClient({ apiKey: "sk-test", fetch, defaultModel: "kai-a7" });
  assert.equal(client.defaultModel, "kai-a7");
  await client.systemOne({ state: "s", questions: { q: noul() } });
  await client.systemOne({ state: "s", questions: { q: noul() }, model: "kai" });
  assert.deepEqual(
    calls.map((c) => (c.body as { model: string }).model),
    ["kai-a7", "kai"],
  );
});

test("reads HANZO_API_KEY, HANZO_BASE_URL and KAI_LOG_LEVEL, and not KAI_MODEL", async () => {
  process.env.HANZO_API_KEY = "sk-env";
  process.env.HANZO_BASE_URL = "https://env.test/";
  process.env.KAI_MODEL = "hanzo/kai";
  process.env.KAI_LOG_LEVEL = "error";
  const { fetch, calls } = scripted(() => json(RESULT));
  const client = new TypeSafeClient({ fetch });
  assert.equal(client.baseURL, "https://env.test");
  assert.equal(client.defaultModel, "kai");
  assert.equal(client.logLevel, "error");
  await client.systemOne({ state: "s", questions: QUESTIONS });
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-env");
  assert.equal((calls[0]?.body as { model: string }).model, "kai");
  assert.deepEqual(ENV, { apiKey: "HANZO_API_KEY", baseURL: "HANZO_BASE_URL", logLevel: "KAI_LOG_LEVEL" });
  delete process.env.HANZO_API_KEY;
  assert.throws(() => new TypeSafeClient(), { name: "KaiError", message: "no API key: pass apiKey, or set HANZO_API_KEY" });
});

test("an answer of a type this client does not know is skipped with a warning", async () => {
  const log = recorder();
  const { fetch } = scripted(() => json({ ...RESULT, answers: { ...RESULT.answers, odd: { type: "rank" } } }));
  const r = await new TypeSafeClient({ apiKey: "sk-test", fetch, logger: log }).systemOne({ state: "s", questions: QUESTIONS });
  assert.deepEqual(Object.keys(r.answers), ["refund", "team", "urgency"]);
  assert.deepEqual(said(log, "warn"), ['answer "odd" has type "rank", which this client does not know; skipped']);
});

test("the path's FastAPI errors surface as the same classes, with the server's sentence", async () => {
  const cases: [number, Record<string, unknown>, Record<string, string>, typeof APIError, string][] = [
    [400, { detail: "Unknown model: jev-latest" }, {}, BadRequestError, "Unknown model: jev-latest"],
    [401, { detail: "invalid API key" }, {}, AuthenticationError, "invalid API key"],
    [
      422,
      { detail: [{ loc: ["body", "questions", "q", "criteria"], msg: "a choice takes at most 255 labels", type: "too_long" }] },
      {},
      UnprocessableEntityError,
      "questions.q.criteria: a choice takes at most 255 labels",
    ],
    [429, { detail: "rate limited" }, { "retry-after": "3" }, RateLimitError, "rate limited"],
  ];
  for (const [status, body, headers, kind, message] of cases) {
    const { fetch } = scripted(() => json(body, status, headers));
    const client = new TypeSafeClient({ apiKey: "sk-test", fetch, retry: { maxRetries: 0 } });
    const error = await client.systemOne({ model: "jev-latest", state: "s", questions: QUESTIONS }).catch((e: unknown) => e);
    assert.ok(error instanceof kind, `status ${status}`);
    assert.equal((error as Error).message, message);
    if (status === 429) assert.equal((error as RateLimitError).retryAfter, 3);
  }
});

test("models.list reads the models key of GET /v1/models", async () => {
  const cards = [{ name: "kai", description: "Hanzo's decision model", release_date: "2026-09-28" }];
  const { fetch, calls } = scripted(() => json({ object: "list", data: [{ id: "kai", outputs: ["decision"] }], models: cards }));
  const client = new TypeSafeClient({ apiKey: "sk-test", fetch });
  assert.deepEqual(await client.models.list(), cards);
  assert.equal(calls[0]?.method, "GET");
  assert.ok(calls[0]?.url.endsWith("/v1/models"));
  const bare = scripted(() => json({ object: "list", data: [] }));
  await assert.rejects(new TypeSafeClient({ apiKey: "sk-test", fetch: bare.fetch }).models.list(), {
    name: "KaiError",
    message: "GET /v1/models answered without a 'models' list",
  });
});

test("the same client-side checks refuse before sending", () => {
  const { fetch, calls } = scripted(() => json(RESULT));
  const client = new TypeSafeClient({ apiKey: "sk-test", fetch });
  assert.throws(() => client.systemOne({ state: "s", questions: {} }), { message: "at least one question is required" });
  assert.equal(calls.length, 0);
});
