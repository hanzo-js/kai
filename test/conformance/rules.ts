// One check per rule of the frozen Kai decision contract, run through the SDK: offline against
// server.ts (test/conformance/offline.test.ts) and live against api.hanzo.ai (scripts/conformance.mjs).
import {
  APIError,
  AuthenticationError,
  BadRequestError,
  choice,
  type EntryType,
  type Kai,
  noul,
  type Questions,
  score,
  UnprocessableEntityError,
} from "@hanzo/kai";
import type { Client } from "@hanzo/kai/jev";
import { argmax, jevScore, spread } from "./server.ts";

/** A client on each path, and the same two holding a key the server does not know. */
export interface Clients {
  kai: Kai;
  jev: Client;
  strangers: { kai: Kai; jev: Client };
}

/** A contract rule: `check` answers what broke it, nothing when it holds. */
export interface Rule {
  name: string;
  check(c: Clients): Promise<string[]>;
}

/** An answer read field by field, whichever path sent it. */
interface Loose {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  answer_confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
}

interface Reply {
  answers: Record<string, Loose>;
  usage: { input_tokens: number; output_tokens: number };
}

type Ask = (questions: Questions, state?: unknown) => Promise<Reply>;

const STATE =
  "My card shows two charges of $49 for the March invoice, and I only have one account. Please refund the duplicate.";
const TEAM = choice("Which team should handle this ticket?", {
  billing: "charges, invoices and refunds",
  technical: "bugs, errors and outages",
  account: "sign-in and profile settings",
});
const URGENCY = score("How urgent is this ticket?", ["can wait", "this week", "today", "right now"]);
const REFUND = noul("The customer asks for money back.", {
  true: "a refund is requested",
  false: "no refund is requested",
});
const EXACT = 1e-9;

const say = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) <= EXACT;
const many = <T>(n: number, make: (i: number) => [string, T]): Record<string, T> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));

/** The failures of `fn`, a throw counted as one. */
async function guard(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (e) {
    return [`threw ${say(e)}`];
  }
}

/** The failures of a call that must reject with `kind`, then of `test` on its error. */
async function refused(p: Promise<unknown>, kind: typeof APIError, test?: (e: APIError) => string[]): Promise<string[]> {
  try {
    await p;
    return [`answered; expected ${kind.name}`];
  } catch (e) {
    if (!(e instanceof kind)) return [`threw ${say(e)}; expected ${kind.name}`];
    return test ? test(e) : [];
  }
}

/** The failures of a refusal over reach: `code` names what is over, and the message says by how much. */
function reached(e: APIError, name: string): string[] {
  const out = e.code === name ? [] : [`code ${JSON.stringify(e.code)}, expected ${name}`];
  return /\d/.test(e.message) ? out : [...out, `message names no size: ${JSON.stringify(e.message)}`];
}

function paths(c: Clients): [string, Ask][] {
  return [
    ["native", (questions, state = STATE) => c.kai.decide({ state: state as EntryType, questions }) as Promise<unknown> as Promise<Reply>],
    ["compat", (questions, state = STATE) => c.jev.systemOne({ state: state as EntryType, questions }) as Promise<unknown> as Promise<Reply>],
  ];
}

/** `fn` on both paths, each failure named by its path. */
async function both(c: Clients, fn: (ask: Ask, path: string) => Promise<string[]>): Promise<string[]> {
  const out: string[] = [];
  for (const [path, ask] of paths(c)) out.push(...(await guard(() => fn(ask, path))).map((f) => `${path}: ${f}`));
  return out;
}

/** The distribution of an answer, in option order. */
const dist = (a: Loose | undefined): number[] => Object.values(a?.probabilities ?? {});

export const RULES: Rule[] = [
  {
    name: "compat refuses every Jev model id with 400 Unknown model",
    check: async (c) => {
      const out: string[] = [];
      for (const id of ["jev-latest", "jev-preview", "jev-1.13.0"]) {
        const f = await refused(c.jev.systemOne({ model: id, state: STATE, questions: { team: TEAM } }), BadRequestError, (e) =>
          e.message === `Unknown model: ${id}` ? [] : [`message ${JSON.stringify(e.message)}`],
        );
        out.push(...f.map((x) => `${id}: ${x}`));
      }
      return out;
    },
  },
  {
    name: "the versioned id kai-<12 hex of the weights' sha256> is taken on both paths and names the compat answer",
    check: (c) =>
      guard(async () => {
        const first = await c.kai.decide({ state: STATE, questions: { team: TEAM } });
        const versioned = `kai-${(first.routing.sha256 ?? "").slice(0, 12)}`;
        if (!/^kai-[0-9a-f]{12}$/.test(versioned)) return [`routing.sha256 ${JSON.stringify(first.routing.sha256)} names no id`];
        const out: string[] = [];
        const native = await c.kai.decide({ model: versioned, state: STATE, questions: { team: TEAM } });
        if (native.answers.team.type !== "choice") out.push(`native ${versioned}: no choice answered`);
        for (const model of ["kai", versioned]) {
          const r = await c.jev.systemOne({ model, state: STATE, questions: { team: TEAM } });
          if (!/^kai-[0-9a-f]{12}$/.test(r.model) || r.model !== versioned) out.push(`compat ${model}: model ${JSON.stringify(r.model)}, expected ${versioned}`);
        }
        return out;
      }),
  },
  {
    name: "native refuses an unknown model with 400",
    check: async (c) => refused(c.kai.decide({ model: "no-such-model", state: STATE, questions: { team: TEAM } }), BadRequestError),
  },
  {
    name: "a question may omit its instructions",
    check: (c) =>
      both(c, async (ask) => {
        const r = await ask({ yes: noul(), pick: choice(undefined, { yes: null, no: null }), level: score(null, ["low", "high"]) });
        const types = [r.answers.yes?.type, r.answers.pick?.type, r.answers.level?.type].join(",");
        return types === "noul,choice,score" ? [] : [`answer types ${types}`];
      }),
  },
  {
    name: "a native noul also takes labels, the words its two sides go by",
    check: (c) =>
      guard(async () => {
        const refund = noul("Does the customer ask for money back?", undefined, { true: "refund", false: "no refund" });
        const r = await c.kai.decide({ state: STATE, questions: { refund } });
        const p = r.answers.refund.noul;
        return r.answers.refund.type === "noul" && p >= 0 && p <= 1 ? [] : [`answer ${JSON.stringify(r.answers.refund)}`];
      }),
  },
  {
    name: "a request holds 1 to 100 questions: 100 are answered, 101 refused with 422",
    check: (c) =>
      both(c, async (ask) => {
        const q = (n: number): Questions => many(n, (i) => [`q${i}`, noul(`Statement ${i} holds.`)]);
        const r = await ask(q(100));
        const out = Object.keys(r.answers).length === 100 ? [] : [`100 questions got ${Object.keys(r.answers).length} answers`];
        return [...out, ...(await refused(ask(q(101)), UnprocessableEntityError))];
      }),
  },
  {
    name: "a choice needs at least 2 labels: 1 is refused with 422",
    check: (c) => both(c, (ask) => refused(ask({ pick: choice("Which?", { only: null }) }), UnprocessableEntityError)),
  },
  {
    name: "compat caps a choice at 255 labels; native takes 256",
    check: async (c) => {
      const pick = choice("Which label fits?", many(256, (i) => [`l${i}`, null]));
      const native = await guard(async () => {
        const r = await c.kai.decide({ state: STATE, questions: { pick } });
        return /^l\d+$/.test(r.answers.pick.choice) ? [] : [`choice ${r.answers.pick.choice}`];
      });
      const compat = await refused(c.jev.systemOne({ state: STATE, questions: { pick } }), UnprocessableEntityError);
      return [...native.map((f) => `native: ${f}`), ...compat.map((f) => `compat: ${f}`)];
    },
  },
  {
    name: "compat caps a score at 10 levels; native takes 11",
    check: async (c) => {
      const level = score("How much?", ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
      const native = await guard(async () => {
        const r = await c.kai.decide({ state: STATE, questions: { level } });
        return Object.keys(r.answers.level.probabilities).length === 11 ? [] : ["not 11 probabilities"];
      });
      const compat = await refused(c.jev.systemOne({ state: STATE, questions: { level } }), UnprocessableEntityError);
      return [...native.map((f) => `native: ${f}`), ...compat.map((f) => `compat: ${f}`)];
    },
  },
  {
    name: "a null score level is refused with 422",
    check: (c) => both(c, (ask) => refused(ask({ level: score("How urgent?", ["low", null] as never) }), UnprocessableEntityError)),
  },
  {
    name: "a null state is refused with 422",
    check: (c) => both(c, (ask) => refused(ask({ team: TEAM }, null), UnprocessableEntityError)),
  },
  {
    name: "every distribution sums to 1 within 1e-6",
    check: (c) =>
      both(c, async (ask) => {
        const r = await ask({ team: TEAM, urgency: URGENCY });
        return ["team", "urgency"].flatMap((q) => {
          const sum = dist(r.answers[q]).reduce((a, b) => a + b, 0);
          return Math.abs(sum - 1) <= 1e-6 ? [] : [`${q} sums to ${sum}`];
        });
      }),
  },
  {
    name: "choice is the strict argmax label; score is the sum of i times p_i",
    check: (c) =>
      both(c, async (ask) => {
        const r = await ask({ team: TEAM, urgency: URGENCY });
        const team = r.answers.team;
        const labels = Object.keys(team?.probabilities ?? {});
        const out = team?.choice === labels[argmax(dist(team))] ? [] : [`choice ${team?.choice} is not the argmax`];
        const expected = dist(r.answers.urgency).reduce((a, p, i) => a + i * p, 0);
        return near(r.answers.urgency?.score, expected) ? out : [...out, `score ${r.answers.urgency?.score}, sum ${expected}`];
      }),
  },
  {
    name: "renaming question ids leaves every probability identical",
    check: (c) =>
      both(c, async (ask) => {
        const a = await ask({ team: TEAM, urgency: URGENCY, refund: REFUND });
        const b = await ask({ q1: TEAM, q2: URGENCY, q3: REFUND });
        const pairs: [string, string][] = [["team", "q1"], ["urgency", "q2"], ["refund", "q3"]];
        return pairs.flatMap(([x, y]) => {
          const same = JSON.stringify([a.answers[x]?.probabilities, a.answers[x]?.noul]) === JSON.stringify([b.answers[y]?.probabilities, b.answers[y]?.noul]);
          return same ? [] : [`${x} and ${y} differ`];
        });
      }),
  },
  {
    name: "usage counts the state once and output_tokens is 0",
    check: (c) =>
      both(c, async (ask) => {
        const state = Array.from({ length: 30 }, () => STATE).join(" ");
        const one = await ask({ q0: REFUND }, state);
        const five = await ask(many(5, (i) => [`q${i}`, REFUND]), state);
        const [u1, u5] = [one.usage.input_tokens, five.usage.input_tokens];
        const out: string[] = [];
        if ((u5 - u1) % 4 !== 0 || u5 - u1 >= u1) out.push(`1 question billed ${u1}, 5 billed ${u5}`);
        if (one.usage.output_tokens !== 0 || five.usage.output_tokens !== 0) out.push("output_tokens is not 0");
        return out;
      }),
  },
  {
    name: "a state past what the model reads is refused with 422 state_too_long",
    check: (c) =>
      both(c, (ask) =>
        refused(ask({ team: TEAM }, Array.from({ length: 20_000 }, (_, i) => `word${i % 97}`).join(" ")), UnprocessableEntityError, (e) =>
          reached(e, "state_too_long"),
        ),
      ),
  },
  {
    name: "a question over half of what the model reads is refused with 422 question_too_long",
    check: (c) =>
      both(c, (ask) =>
        refused(ask({ long: noul(Array.from({ length: 6_000 }, (_, i) => `clause${i % 89}`).join(" ")) }), UnprocessableEntityError, (e) =>
          reached(e, "question_too_long"),
        ),
      ),
  },
  {
    name: "an option over 512 tokens is refused with 422 option_too_long",
    check: (c) =>
      both(c, (ask) =>
        refused(
          ask({ team: choice("Which team should handle `ticket`?", { billing: Array.from({ length: 1_500 }, (_, i) => `charge${i % 83}`).join(" "), technical: null }) }),
          UnprocessableEntityError,
          (e) => reached(e, "option_too_long"),
        ),
      ),
  },
  {
    name: "a body over 16 MiB is refused with 422 request_too_long",
    check: (c) =>
      both(c, (ask) => refused(ask({ team: TEAM }, "x".repeat(17 << 20)), UnprocessableEntityError, (e) => reached(e, "request_too_long"))),
  },
  {
    name: "native noul confidence is |2p - 1|",
    check: (c) =>
      guard(async () => {
        const r = await c.kai.decide({ state: STATE, questions: { refund: REFUND } });
        const { noul: p, confidence } = r.answers.refund;
        return near(confidence, Math.abs(2 * p - 1)) ? [] : [`noul ${p}, confidence ${confidence}`];
      }),
  },
  {
    name: "native choice and score confidence is (n p_max - 1)/(n - 1), answer_confidence is p_max",
    check: (c) =>
      guard(async () => {
        const r = await c.kai.decide({ state: STATE, questions: { team: TEAM, urgency: URGENCY } });
        return (["team", "urgency"] as const).flatMap((q) => {
          const a = r.answers[q] as Loose;
          const p = dist(a);
          const out = near(a.confidence, spread(p)) ? [] : [`${q} confidence ${a.confidence}, expected ${spread(p)}`];
          return near(a.answer_confidence, Math.max(...p)) ? out : [...out, `${q} answer_confidence ${a.answer_confidence}`];
        });
      }),
  },
  {
    name: "compat answers in Jev's shape with no Kai metadata",
    check: (c) =>
      guard(async () => {
        const response = await c.jev.systemOne({ state: STATE, questions: { team: TEAM, urgency: URGENCY, refund: REFUND } }).asResponse();
        const body = (await response.json()) as { answers: Record<string, object>; usage: object };
        const keys = (o: object | undefined): string => Object.keys(o ?? {}).sort().join(",");
        const want: [string, string][] = [
          [keys(body), "answers,model,usage"],
          [keys(body.usage), "input_tokens,output_tokens"],
          [keys(body.answers.refund), "noul,type"],
          [keys(body.answers.team), "choice,confidence,probabilities,type"],
          [keys(body.answers.urgency), "confidence,legend,probabilities,score,type"],
        ];
        return want.flatMap(([got, expected]) => (got === expected ? [] : [`keys ${got}, expected ${expected}`]));
      }),
  },
  {
    name: "compat echoes a score's criteria verbatim as its legend",
    check: (c) =>
      guard(async () => {
        const levels = ["can wait", { level: "soon", examples: ["this week"] }, ["today", "right now"]] as const;
        const r = await c.jev.systemOne({ state: STATE, questions: { urgency: score("How urgent?", levels) } });
        const want = { "0": levels[0], "1": levels[1], "2": levels[2] };
        return JSON.stringify(r.answers.urgency.legend) === JSON.stringify(want) ? [] : [`legend ${JSON.stringify(r.answers.urgency.legend)}`];
      }),
  },
  {
    name: "compat choice confidence is (n p_max - 1)/(n - 1); score confidence is Jev's",
    check: (c) =>
      guard(async () => {
        const r = await c.jev.systemOne({ state: STATE, questions: { team: TEAM, urgency: URGENCY } });
        const team = dist(r.answers.team as Loose);
        const urgency = dist(r.answers.urgency as Loose);
        const out = near(r.answers.team.confidence, spread(team)) ? [] : [`choice confidence ${r.answers.team.confidence}, expected ${spread(team)}`];
        return near(r.answers.urgency.confidence, jevScore(urgency))
          ? out
          : [...out, `score confidence ${r.answers.urgency.confidence}, expected ${jevScore(urgency)}`];
      }),
  },
  {
    name: "native errors are {error: {code, message}}; compat errors are FastAPI's detail",
    check: async (c) => {
      const native = await refused(c.kai.decide({ state: null as never, questions: { team: TEAM } }), UnprocessableEntityError, (e) => {
        const error = (e.body as { error?: { code?: unknown; message?: unknown } }).error;
        return error && error.code !== undefined && typeof error.message === "string" ? [] : [`body ${JSON.stringify(e.body)}`];
      });
      const invalid = await refused(c.jev.systemOne({ state: null as never, questions: { team: TEAM } }), UnprocessableEntityError, (e) => {
        const detail = (e.body as { detail?: unknown }).detail;
        const ok = Array.isArray(detail) && detail.every((d) => typeof d === "object" && d !== null && "loc" in d && "msg" in d && "type" in d);
        return ok ? [] : [`body ${JSON.stringify(e.body)}`];
      });
      const unknown = await refused(c.jev.systemOne({ model: "jev-latest", state: STATE, questions: { team: TEAM } }), BadRequestError, (e) =>
        JSON.stringify(e.body) === JSON.stringify({ detail: "Unknown model: jev-latest" }) ? [] : [`body ${JSON.stringify(e.body)}`],
      );
      return [...native.map((f) => `native 422: ${f}`), ...invalid.map((f) => `compat 422: ${f}`), ...unknown.map((f) => `compat 400: ${f}`)];
    },
  },
  {
    name: "a key the server does not know is refused with 401",
    check: async (c) => [
      ...(await refused(c.strangers.kai.decide({ state: STATE, questions: { team: TEAM } }), AuthenticationError)).map((f) => `native: ${f}`),
      ...(await refused(c.strangers.jev.systemOne({ state: STATE, questions: { team: TEAM } }), AuthenticationError)).map((f) => `compat: ${f}`),
    ],
  },
  {
    name: "GET /v1/models lists the decision models under data; the jev layer shows them as Jev's cards",
    check: (c) =>
      guard(async () => {
        const ids = (await c.kai.models.list()).map((m) => m.id);
        const out = ids.includes("kai") ? [] : [`data holds ${ids.join(", ")}`];
        const cards = await c.jev.models.list();
        const kai = cards.find((m) => m.name === "kai");
        const shaped = kai && kai.description === "" && /^\d{4}-\d{2}-\d{2}$/.test(kai.release_date);
        return shaped ? out : [...out, `cards ${JSON.stringify(cards)}`];
      }),
  },
  {
    name: "every response carries x-request-id",
    check: async (c) => {
      const out: string[] = [];
      const seen = async (what: string, p: Promise<{ requestId: string | undefined }>): Promise<void> => {
        const f = await guard(async () => ((await p).requestId ? [] : ["none"]));
        out.push(...f.map((x) => `${what}: ${x}`));
      };
      await seen("native 200", c.kai.decide({ state: STATE, questions: { team: TEAM } }).withResponse());
      await seen("compat 200", c.jev.systemOne({ state: STATE, questions: { team: TEAM } }).withResponse());
      await seen("models 200", c.kai.models.list().withResponse());
      const failing: [string, () => Promise<unknown>][] = [
        ["native 422", () => c.kai.decide({ state: null as never, questions: { team: TEAM } })],
        ["compat 400", () => c.jev.systemOne({ model: "jev-latest", state: STATE, questions: { team: TEAM } })],
        ["compat 422", () => c.jev.systemOne({ state: null as never, questions: { team: TEAM } })],
      ];
      for (const [what, send] of failing) {
        const e = await send().then(
          () => undefined,
          (x: unknown) => x,
        );
        if (!(e instanceof APIError)) out.push(`${what}: ${e === undefined ? "answered" : say(e)}`);
        else if (!e.requestId) out.push(`${what}: none`);
      }
      return out;
    },
  },
];
