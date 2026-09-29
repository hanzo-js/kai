// The frozen contract as a scripted fetch: what api.hanzo.ai answers once the contract is deployed.
// Tokens are whitespace-separated words; probabilities come from a hash of state, instructions and option.
import type { Fetch } from "@hanzo/kai";

/** The key the fake accepts; any other is refused with 401. */
export const KEY = "sk-conformance";
/** Tokens a state plus any one question may take; a question alone may take half. */
export const REACH = 8192;
/** Tokens an option is read whole up to. */
export const OPTION = 512;
/** Bytes a body may hold. */
export const BODY = 16 << 20;
/** The weights' SHA-256, and Kai's versioned id from it: `kai-` and its first 12 hex digits. */
export const SHA256 = "a211cc70103825bfbc9bfb0f6a7c1e4d2b39f8e05c6d47a19b2e3f40c5d6e7f8";
export const VERSIONED = `kai-${SHA256.slice(0, 12)}`;
/** Jev's own ids, which reach Jev on both paths. */
const JEV = ["typesafe/jev-1.13", "~typesafe/jev-latest"];

type Json = unknown;
type Map = Record<string, Json>;

const map = (v: Json): v is Map => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: Json): string => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const words = (v: Json): number => text(v).split(/\s+/).filter(Boolean).length;

/** FNV-1a over the text, as a logit in [-3, 3). */
function logit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return (h / 2 ** 32) * 6 - 3;
}

function softmax(logits: number[]): number[] {
  const top = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - top));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / sum);
}

/** The first index of the largest value. */
export function argmax(p: number[]): number {
  let best = 0;
  for (let i = 1; i < p.length; i++) if ((p[i] ?? 0) > (p[best] ?? 0)) best = i;
  return best;
}

/** (n·p_max − 1)/(n − 1); one option is fully decided. */
export function spread(p: number[]): number {
  return p.length < 2 ? 1 : (p.length * Math.max(...p) - 1) / (p.length - 1);
}

/** Jev's score confidence: 1 − E|i − mode| over the mean absolute deviation of a uniform scale. */
export function jevScore(p: number[]): number {
  if (p.length < 2) return 1;
  const mode = argmax(p);
  const far = p.reduce((a, pi, i) => a + pi * Math.abs(i - mode), 0);
  const center = (p.length - 1) / 2;
  const uniform = p.reduce((a, _, i) => a + Math.abs(i - center), 0) / p.length;
  return Math.max(0, 1 - far / uniform);
}

/** Why a question is outside the contract on this path, or undefined. */
function invalid(q: Json, compat: boolean): string | undefined {
  if (!map(q)) return "a question must be an object";
  const c = q.criteria;
  if (q.type === "noul") {
    const words = q.labels;
    if (words !== undefined) {
      if (compat) return "labels is taken on /v1/decisions only";
      if (!map(words) || Object.keys(words).sort().join() !== "false,true" || !Object.values(words).every((w) => typeof w === "string")) {
        return "labels names 'true' and 'false'";
      }
    }
    if (c == null) return undefined;
    if (!map(c) || Object.keys(c).some((k) => k !== "true" && k !== "false")) return "noul criteria are keyed true and false";
    return undefined;
  }
  if (q.type === "choice") {
    const n = map(c) ? Object.keys(c).length : Array.isArray(c) && !compat ? c.length : -1;
    if (n < 0) return "choice criteria map labels to descriptions";
    if (n < 2) return "a choice needs at least 2 labels";
    if (compat && n > 255) return "a choice takes at most 255 labels";
    return undefined;
  }
  if (q.type === "score") {
    if (!Array.isArray(c) || c.length < 1) return "a score needs at least 1 level";
    if (compat && c.length > 10) return "a score takes at most 10 levels";
    const i = c.findIndex((l) => l === null);
    return i < 0 ? undefined : `score level ${i} is null`;
  }
  return "type must be noul, choice or score";
}

/** Option texts in order: a choice's labels, a score's levels, a noul's false and true. */
function options(q: Map): [string, Json][] {
  const c = q.criteria;
  if (q.type === "choice") return map(c) ? Object.entries(c) : (c as string[]).map((l) => [l, null]);
  if (q.type === "score") return (c as Json[]).map((l, i) => [String(i), l]);
  const sides = map(c) ? c : {};
  const words = map(q.labels) ? q.labels : { false: "false", true: "true" };
  return [
    [String(words.false), sides.false ?? null],
    [String(words.true), sides.true ?? null],
  ];
}

function answer(state: Json, q: Map, compat: boolean): Map {
  const opts = options(q);
  const p = softmax(opts.map(([k, v]) => logit(`${text(state)}\u0000${text(q.instructions)}\u0000${k}\u0000${text(v)}`)));
  const best = argmax(p);
  const pmax = p[best] ?? 0;
  if (q.type === "noul") {
    const yes = p[1] ?? 0;
    return compat ? { type: "noul", noul: yes } : { type: "noul", noul: yes, confidence: Math.abs(2 * yes - 1), answer_confidence: pmax };
  }
  if (q.type === "choice") {
    const probabilities = Object.fromEntries(opts.map(([k], i) => [k, p[i]]));
    const base = { type: "choice", choice: opts[best]?.[0], confidence: spread(p), probabilities };
    return compat ? base : { ...base, answer_confidence: pmax };
  }
  const levels = q.criteria as Json[];
  const legend = Object.fromEntries(levels.map((l, i) => [String(i), l]));
  const probabilities = Object.fromEntries(p.map((pi, i) => [String(i), pi]));
  const expected = p.reduce((a, pi, i) => a + i * pi, 0);
  return compat
    ? { type: "score", score: expected, confidence: jevScore(p), legend, probabilities }
    : { type: "score", score: expected, confidence: spread(p), answer_confidence: pmax, legend, probabilities };
}

/** A fetch answering /v1/decisions, /v1/systemone and /v1/models as the contract says. */
export function contract(): Fetch {
  let n = 0;
  return async (url, init) => {
    const id = `req_${String(++n).padStart(4, "0")}`;
    const path = new URL(url).pathname;
    const compat = path === "/v1/systemone";
    const reply = (status: number, body: Json): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-request-id": id },
      });
    const fail = (status: number, message: string, code?: string, loc: Json[] = ["body"]): Response => {
      if (!compat) return reply(status, { error: { code: code ?? status, message } });
      if (status === 422) return reply(422, { detail: [{ loc, msg: message, type: code ?? "value_error" }] });
      return reply(status, { detail: message });
    };
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`) return fail(401, "invalid API key");
    if (path === "/v1/models") {
      const kai = { object: "model", created: 1790629541, owned_by: "hanzo", outputs: ["decision"], pricing: { input: 0.021, output: 0 } };
      return reply(200, {
        object: "list",
        data: [{ id: "hanzo/kai", ...kai }, { id: "kai", ...kai }],
        models: [],
      });
    }
    if (path !== "/v1/decisions" && !compat) return fail(404, "not found");
    const raw = String(init?.body);
    if (raw.length > BODY) return fail(422, `the body is over ${BODY} bytes`, "request_too_long");
    let body: Json;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "malformed JSON");
    }
    if (!map(body)) return fail(422, "the body must be an object");
    const model = body.model;
    const models = compat ? ["kai", VERSIONED, ...JEV] : ["kai", "hanzo/kai", VERSIONED, ...JEV];
    if (typeof model !== "string" || !models.includes(model)) {
      return compat ? reply(400, { detail: `Unknown model: ${String(model)}` }) : fail(400, `unknown model ${JSON.stringify(model)}`);
    }
    const state = body.state;
    if (!(typeof state === "string" || (typeof state === "object" && state !== null))) {
      return fail(422, "'state' must be a string, an object or an array");
    }
    const entries = map(body.questions) ? Object.entries(body.questions) : [];
    if (entries.length < 1 || entries.length > 100) return fail(422, `'questions' holds ${entries.length}; 1 to 100 are allowed`);
    for (const [name, q] of entries) {
      const why = invalid(q, compat);
      if (why) return fail(422, `question '${name}': ${why}`);
    }
    const questions = entries as [string, Map][];
    const cost = (q: Map): number => words(q.instructions) + options(q).reduce((a, [k, v]) => a + words(k) + words(v), 0);
    for (const [name, q] of questions) {
      const at = ["body", "questions", name, q.type];
      const prompt = words(q.instructions) + 3;
      if (prompt > REACH / 2) {
        return fail(422, `question "${name}" takes ${prompt} tokens with its type line; ${VERSIONED} reads at most ${REACH / 2}`, "question_too_long", [...at, "instructions"]);
      }
      if (words(state) + prompt > REACH) {
        return fail(422, `the state and question "${name}" take ${words(state) + prompt} tokens; ${VERSIONED} reads at most ${REACH}`, "state_too_long", ["body", "state"]);
      }
      for (const [key, v] of options(q)) {
        const n = words(key) + words(v);
        if (n > OPTION) {
          return fail(422, `option ${key} of question "${name}" takes ${n} tokens; ${VERSIONED} reads an option whole up to ${OPTION}`, "option_too_long", [...at, "criteria", key]);
        }
      }
    }
    const answers = Object.fromEntries(questions.map(([name, q]) => [name, answer(state, q, compat)]));
    const usage = { input_tokens: words(state) + questions.reduce((a, [, q]) => a + cost(q), 0), output_tokens: 0 };
    const answering = JEV.includes(model) ? `${model}-20260917` : VERSIONED;
    if (compat) return reply(200, { model: answering, answers, usage });
    return reply(200, {
      id: `dec_${"0".repeat(28)}${String(n).padStart(4, "0")}`,
      model,
      provider: "Hanzo",
      answers,
      usage,
      routing: JEV.includes(model)
        ? { backend: "openrouter", checkpoint: answering, reason: `explicit model='${model}'` }
        : { backend: "kai", checkpoint: "a7", sha256: SHA256, reason: `explicit model='${model}'` },
      state_hash: "sha256:0",
      latency_ms: 1,
    });
  };
}
