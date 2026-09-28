import assert from "node:assert/strict";
import { test } from "node:test";
import { choice, Kai, KaiError, noul, score, VERSION } from "@hanzo/kai";
import { DECISION, json, scripted } from "./fetch.ts";

const client = (extra: ConstructorParameters<typeof Kai>[0] = {}) => {
  const { fetch, calls } = scripted(() => json(DECISION));
  return { kai: new Kai({ apiKey: "sk-test", baseURL: "https://api.test", fetch, ...extra }), calls };
};

test("decide posts model, state and questions to /v1/decisions with auth and identity headers", async () => {
  const { kai, calls } = client();
  await kai.decide({
    state: { ticket: "I was charged twice." },
    questions: {
      team: choice("Which team?", { billing: "charges", tech: null }),
      refund: noul("The customer asks for money back.", { true: "a refund is requested" }),
      urgency: score("How urgent?", ["can wait", "this week", "today"]),
    },
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.url, "https://api.test/v1/decisions");
  assert.equal(call?.method, "POST");
  assert.deepEqual(call?.body, {
    model: "kai",
    state: { ticket: "I was charged twice." },
    questions: {
      team: { type: "choice", instructions: "Which team?", criteria: { billing: "charges", tech: null } },
      refund: {
        type: "noul",
        instructions: "The customer asks for money back.",
        criteria: { true: "a refund is requested" },
      },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["can wait", "this week", "today"] },
    },
  });
  const h = call?.headers;
  assert.equal(h?.get("authorization"), "Bearer sk-test");
  assert.equal(h?.get("content-type"), "application/json");
  assert.equal(h?.get("accept"), "application/json");
  assert.equal(h?.get("user-agent"), `@hanzo/kai/${VERSION}`);
  assert.match(h?.get("x-kai-runtime") ?? "", /^node\/\d+\.\d+\.\d+ \([a-z0-9]+; [a-z0-9]+\)$/);
  assert.equal(h?.has("x-kai-retry-count"), false);
});

test("a call's model overrides the client's, and hanzo/kai is sent as given", async () => {
  const { kai, calls } = client({ model: "hanzo/kai" });
  await kai.decide({ state: "s", questions: { q: noul("q?") } });
  await kai.decide({ state: "s", questions: { q: noul("q?") }, model: "kai" });
  assert.equal((calls[0]?.body as { model: string }).model, "hanzo/kai");
  assert.equal((calls[1]?.body as { model: string }).model, "kai");
});

test("optional request fields and fields this client does not know are sent as given", async () => {
  const { kai, calls } = client();
  const request = {
    state: ["line one", { line: 2 }],
    questions: { q: noul({ ask: "Is it spam?" }) },
    session_id: "s-1",
    user: "u-1",
    trace: { run: 7 },
    provider: { order: ["hanzo"] },
    handle: "h-1",
  };
  await kai.decide(request);
  assert.deepEqual(calls[0]?.body, { model: "kai", ...request });
});

test("default and per-call headers merge, the call winning; auth and identity cannot be replaced", async () => {
  const { kai, calls } = client({
    defaultHeaders: { "X-Team": "client", "X-Only-Client": "1", Authorization: "Bearer other", "X-Kai-Retry-Count": "9" },
  });
  await kai.decide(
    { state: "s", questions: { q: noul("q?") } },
    { headers: { "X-Team": "call", "X-Only-Call": "1", "User-Agent": "mine" } },
  );
  const h = calls[0]?.headers;
  assert.equal(h?.get("x-team"), "call");
  assert.equal(h?.get("x-only-client"), "1");
  assert.equal(h?.get("x-only-call"), "1");
  assert.equal(h?.get("authorization"), "Bearer sk-test");
  assert.equal(h?.get("user-agent"), `@hanzo/kai/${VERSION}`);
  assert.equal(h?.has("x-kai-retry-count"), false);
});

test("models.list is a GET with no body and no content type", async () => {
  const { fetch, calls } = scripted(() => json({ object: "list", data: [] }));
  await new Kai({ apiKey: "sk-test", baseURL: "https://api.test/", fetch }).models.list();
  assert.equal(calls[0]?.url, "https://api.test/v1/models");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.body, undefined);
  assert.equal(calls[0]?.headers.has("content-type"), false);
});

test("builders keep what they are given and omit a noul's absent criteria", () => {
  assert.deepEqual(noul("Spam?"), { type: "noul", instructions: "Spam?" });
  assert.deepEqual(noul("Spam?", null), { type: "noul", instructions: "Spam?", criteria: null });
  assert.deepEqual(noul("Spam?", { false: "a real message" }), {
    type: "noul",
    instructions: "Spam?",
    criteria: { false: "a real message" },
  });
  assert.deepEqual(choice("Tone?", ["calm", "angry"]), { type: "choice", instructions: "Tone?", criteria: ["calm", "angry"] });
  const rich = { summary: "charges", examples: ["double charge", "refund"] };
  assert.deepEqual(choice(["Team?", { context: "support" }], { billing: rich, tech: null }).criteria.billing, rich);
  assert.deepEqual(score("Risk?", ["low", { level: "high" }]).criteria, ["low", { level: "high" }]);
});

test("builders refuse criteria of the wrong shape", () => {
  const loose = (v: unknown) => v as never;
  assert.throws(() => score("Risk?", loose({ 0: "low", 1: "high" })), {
    name: "KaiError",
    message: "score criteria must list the levels, lowest first",
  });
  assert.throws(() => choice("Team?", loose("billing")), {
    name: "KaiError",
    message: "choice criteria must map labels to descriptions, or list the labels",
  });
  assert.throws(() => choice("Team?", loose(null)), KaiError);
});

test("decide refuses no questions and malformed criteria before sending anything", () => {
  const { kai, calls } = client();
  const ask = (questions: unknown) => kai.decide({ state: "s", questions: questions as never });
  assert.throws(() => ask({}), { name: "KaiError", message: "at least one question is required" });
  assert.throws(() => ask(undefined), { name: "KaiError", message: "at least one question is required" });
  assert.throws(() => ask({ q: { type: "score", instructions: "x", criteria: { 0: "low" } } }), {
    name: "KaiError",
    message: 'question "q": score criteria must list the levels, lowest first',
  });
  assert.throws(() => ask({ q: { type: "choice", instructions: "x", criteria: "a" } }), {
    name: "KaiError",
    message: 'question "q": choice criteria must map labels to descriptions, or list the labels',
  });
  assert.equal(calls.length, 0);
});

test("what the server can judge is left to it: missing instructions, null levels, many questions", async () => {
  const { kai, calls } = client();
  const questions = Object.fromEntries(
    Array.from({ length: 80 }, (_, i) => [`q${i}`, { type: "score", instructions: "x", criteria: ["a", null] }]),
  );
  await kai.decide({ state: "s", questions: { ...questions, bare: { type: "noul" } } as never });
  assert.equal(calls.length, 1);
});
