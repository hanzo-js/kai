import assert from "node:assert/strict";
import { test } from "node:test";
import { APIPromise, choice, Kai, KaiError, NotFoundError, noul, score } from "@hanzo/kai";
import { DECISION, json, recorder, said, scripted } from "./fetch.ts";

const QUESTIONS = {
  team: choice("Which team?", { billing: "charges", tech: "bugs" }),
  refund: noul("The customer asks for money back.", { true: "a refund is requested", false: "anything else" }),
  urgency: score("How urgent?", ["can wait", "this week", "today"]),
};

const answering = (body: unknown, headers: Record<string, string> = {}) => {
  const log = recorder();
  const { fetch, calls } = scripted(() => json(body, 200, headers));
  const kai = new Kai({ apiKey: "sk-test", fetch, logger: log, retry: { maxRetries: 0 } });
  return { kai, log, calls };
};

test("each answer type comes back as sent, typed by its question", async () => {
  const { kai } = answering(DECISION);
  const d = await kai.decide({ state: "I was charged twice.", questions: QUESTIONS });
  assert.equal(d.id, DECISION.id);
  assert.equal(d.model, "kai");
  assert.equal(d.provider, "Hanzo");
  assert.equal(d.answers.team.type, "choice");
  assert.equal(d.answers.team.choice, "billing");
  assert.equal(d.answers.team.confidence, 0.9);
  assert.deepEqual(d.answers.team.probabilities, { billing: 0.9333, tech: 0.0667 });
  assert.equal(d.answers.refund.type, "noul");
  assert.equal(d.answers.refund.noul, 0.81);
  assert.equal(d.answers.urgency.type, "score");
  assert.equal(d.answers.urgency.score, 1.25);
  assert.equal(d.answers.urgency.confidence, 0.3);
  assert.equal(d.answers.urgency.legend[2], "today");
  assert.equal(d.answers.urgency.probabilities["1"], 0.35);
  assert.deepEqual(d.usage, { input_tokens: 120, output_tokens: 0 });
});

test("a choice asked as a list of labels answers with one of them", async () => {
  const { kai } = answering({
    ...DECISION,
    answers: { tone: { type: "choice", choice: "angry", confidence: 0.87, probabilities: { calm: 0.06, angry: 0.94 } } },
  });
  const d = await kai.decide({ state: "Fix this now!", questions: { tone: choice("Tone?", ["calm", "angry"]) } });
  assert.equal(d.answers.tone.choice, "angry");
  assert.equal(d.answers.tone.probabilities.calm, 0.06);
});

test("an answer of a type this client does not know is skipped with a warning", async () => {
  const { kai, log } = answering({
    ...DECISION,
    answers: { ...DECISION.answers, span: { type: "span", start: 3, end: 9 }, bare: 0.5 },
  });
  const d = await kai.decide({ state: "s", questions: QUESTIONS });
  assert.deepEqual(Object.keys(d.answers), ["team", "refund", "urgency"]);
  assert.deepEqual(said(log, "warn"), [
    'answer "span" has type "span", which this client does not know; skipped',
    'answer "bare" has type undefined, which this client does not know; skipped',
  ]);
});

test("fields beyond the typed ones are kept, not rejected", async () => {
  const body = {
    ...DECISION,
    answers: {
      ...DECISION.answers,
      refund: { type: "noul", noul: 0.81, answer_confidence: 0.81, action: { act_probability: 0.93 }, note: "x" },
    },
    usage: { input_tokens: 120, output_tokens: 0, cost: 0.0000025 },
    extra: { anything: [1, 2] },
  };
  const { kai } = answering(body);
  const d = await kai.decide({ state: "s", questions: QUESTIONS });
  assert.equal(d.answers.refund.answer_confidence, 0.81);
  assert.deepEqual(d.answers.refund.action, { act_probability: 0.93 });
  assert.equal((d.answers.refund as unknown as { note: string }).note, "x");
  assert.equal(d.answers.team.answer_confidence, 0.9333);
  assert.equal(d.usage.cost, 0.0000025);
  assert.deepEqual(d.routing, DECISION.routing);
  assert.equal(d.state_hash, DECISION.state_hash);
  assert.equal(d.latency_ms, 212.06);
  assert.deepEqual((d as unknown as { extra: unknown }).extra, { anything: [1, 2] });
});

test("a body with its keys sorted, as model hanzo/kai returns it, parses by name", async () => {
  const text =
    '{"answers":{"urgency":{"answer_confidence":0.7113,"confidence":0.4226,"legend":{"0":"low","1":"high"},' +
    '"probabilities":{"0":0.2887,"1":0.7113},"score":0.7113,"type":"score"}},' +
    '"id":"dec_575d9abfc160db5d96d17754c369fb69","latency_ms":32.709755,"model":"hanzo/kai","provider":"Hanzo",' +
    '"routing":{"backend":"kai","calibration":"cal_e23c27a1f768bff7","checkpoint":"a7","device":"cpu",' +
    '"reason":"explicit model=\'kai\'"},"state_hash":"sha256:a4c1","usage":{"input_tokens":28,"output_tokens":0}}';
  const { fetch } = scripted(() => new Response(text, { headers: { "content-type": "application/json" } }));
  const kai = new Kai({ apiKey: "sk-test", fetch, model: "hanzo/kai" });
  const d = await kai.decide({ state: "I was charged twice.", questions: { urgency: score("Urgency?", ["low", "high"]) } });
  assert.equal(d.model, "hanzo/kai");
  assert.equal(d.answers.urgency.score, 0.7113);
  assert.equal(d.answers.urgency.legend[1], "high");
  assert.equal(d.answers.urgency.probabilities[0], 0.2887);
  assert.equal(d.usage.input_tokens, 28);
});

test("a 2xx body without answers is refused", async () => {
  for (const body of [{ id: "dec_x" }, [1], "not json"]) {
    const { fetch } = scripted(() => new Response(typeof body === "string" ? body : JSON.stringify(body)));
    const kai = new Kai({ apiKey: "sk-test", fetch });
    await assert.rejects(kai.decide({ state: "s", questions: { q: noul("q?") } }), {
      name: "KaiError",
      message: "POST /v1/decisions answered without an 'answers' object",
    });
  }
});

test("withResponse gives the data, the response and its x-request-id", async () => {
  const { kai } = answering(DECISION, { "x-request-id": "9a9cb869" });
  const { data, response, requestId } = await kai.decide({ state: "s", questions: QUESTIONS }).withResponse();
  assert.equal(data.answers.team.choice, "billing");
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal(requestId, "9a9cb869");
  assert.equal(response.bodyUsed, false);
  const { requestId: none } = await answering(DECISION).kai.decide({ state: "s", questions: QUESTIONS }).withResponse();
  assert.equal(none, undefined);
});

test("asResponse gives the response with its body unread", async () => {
  const { kai } = answering(DECISION);
  const response = await kai.decide({ state: "s", questions: QUESTIONS }).asResponse();
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), DECISION);
});

test("an APIPromise is a Promise that parses once for every consumer", async () => {
  const log = recorder();
  const { fetch, calls } = scripted(() => json(DECISION));
  const kai = new Kai({ apiKey: "sk-test", fetch, logger: log, logLevel: "debug" });
  const p = kai.decide({ state: "s", questions: QUESTIONS });
  assert.ok(p instanceof APIPromise);
  assert.ok(p instanceof Promise);
  const [a, b, { data: c }] = await Promise.all([p, p.then((d) => d.answers.team.choice), p.withResponse()]);
  assert.equal(a, c);
  assert.equal(b, "billing");
  assert.equal(calls.length, 1);
  assert.deepEqual(said(log, "debug").filter((m) => m.endsWith("<- body")), ["#1 POST /v1/decisions <- body"]);
  const done: string[] = [];
  const settled = await p.finally(() => done.push("finally")).then(() => "ok");
  assert.equal(settled, "ok");
  assert.deepEqual(done, ["finally"]);
});

test("the request is sent without awaiting, and a status outside 2xx rejects every path", async () => {
  const { fetch, calls } = scripted(() => json({ error: { code: 404, message: "no route" } }, 404));
  const kai = new Kai({ apiKey: "sk-test", fetch });
  kai.models.list().catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  await assert.rejects(kai.models.list(), NotFoundError);
  await assert.rejects(kai.models.list().withResponse(), NotFoundError);
  await assert.rejects(kai.models.list().asResponse(), NotFoundError);
  assert.equal(await kai.models.list().catch((e: unknown) => e instanceof KaiError), true);
});
