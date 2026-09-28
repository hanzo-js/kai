// Checked by `npm run typecheck`, never run: every `@ts-expect-error` must be an error, every `same` must hold.
import {
  type APIPromise,
  type Answer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  choice,
  type Decision,
  type Kai,
  type Model,
  type NoulAnswer,
  type NoulQuestion,
  noul,
  type Question,
  type RetryPolicy,
  type Routing,
  type ScoreAnswer,
  score,
  type Usage,
  type WithResponse,
} from "@hanzo/kai";
import {
  type ChoiceResponse,
  type Client,
  type ModelCard,
  type NoulResponse,
  type Result,
  type ScoreResponse,
  choice as jevChoice,
} from "@hanzo/kai/jev";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(..._: Equal<A, B> extends true ? [] : [never]): void => {};

declare const kai: Kai;

export async function inference(): Promise<void> {
  const d = await kai.decide({
    state: { ticket: "I was charged twice." },
    questions: {
      team: choice("Which team?", { billing: "charges", tech: null }),
      tone: choice("Tone?", ["calm", "angry"]),
      refund: noul("The customer asks for money back.", { true: "a refund is requested" }),
      urgency: score("How urgent?", ["can wait", "today"]),
    },
  });

  same<typeof d.answers.team, ChoiceAnswer<{ readonly billing: "charges"; readonly tech: null }>>();
  same<typeof d.answers.team.choice, "billing" | "tech">();
  same<typeof d.answers.team.probabilities, { readonly billing: number; readonly tech: number }>();
  same<typeof d.answers.tone.choice, "calm" | "angry">();
  same<typeof d.answers.tone.probabilities, { readonly calm: number; readonly angry: number }>();
  same<typeof d.answers.refund, NoulAnswer>();
  same<typeof d.answers.refund.noul, number>();
  same<typeof d.answers.urgency, ScoreAnswer<readonly ["can wait", "today"]>>();
  same<typeof d.answers.urgency.score, number>();
  same<typeof d.answers.urgency.legend, { readonly 0: "can wait"; readonly 1: "today" }>();
  same<typeof d.answers.urgency.probabilities, { readonly 0: number; readonly 1: number }>();
  same<typeof d.answers.urgency.answer_confidence, number | undefined>();
  same<typeof d.answers.refund.action, { readonly act_probability: number } | undefined>();
  same<typeof d.answers.refund.confidence, number | undefined>();
  same<typeof d.id, string>();
  same<typeof d.usage, Usage>();
  same<typeof d.usage.cost, number | undefined>();
  same<typeof d.routing, Routing>();
  same<typeof d.state_hash, string>();
  same<typeof d.latency_ms, number>();

  // @ts-expect-error no such label
  d.answers.team.probabilities.sales;
  // @ts-expect-error no such level
  d.answers.urgency.probabilities[2];
  // @ts-expect-error no such level
  d.answers.urgency.legend[2];
  // @ts-expect-error no such question
  d.answers.other;
  // @ts-expect-error a noul has no choice
  d.answers.refund.choice;
  // @ts-expect-error answers are read-only
  d.answers.refund.noul = 1;
  // @ts-expect-error a decision is read-only
  d.model = "other";
  // @ts-expect-error usage is read-only
  d.usage.input_tokens = 0;
}

export async function rubrics(): Promise<void> {
  const d = await kai.decide({
    state: "s",
    questions: { risk: score("Risk?", ["low", "medium", { level: "high", note: "page someone" }]) },
  });
  same<
    typeof d.answers.risk.legend,
    { readonly 0: "low"; readonly 1: "medium"; readonly 2: { readonly level: "high"; readonly note: "page someone" } }
  >();
  same<typeof d.answers.risk.legend[2]["level"], "high">();

  const levels: [string, ...string[]] = ["low", "high"];
  const loose = await kai.decide({ state: "s", questions: { risk: score("Risk?", levels) } });
  same<typeof loose.answers.risk.probabilities, { readonly [level: number]: number }>();
  same<typeof loose.answers.risk.legend, { readonly [level: number]: string }>();

  const labels: string[] = ["a", "b"];
  const open = await kai.decide({ state: "s", questions: { pick: choice("Which?", labels) } });
  same<typeof open.answers.pick.choice, string>();
}

export async function literals(): Promise<void> {
  const d = await kai.decide({
    state: ["line", { n: 1 }],
    questions: {
      bare: { type: "noul", instructions: "Spam?" },
      listed: { type: "choice", instructions: "Tone?", criteria: ["calm", "angry"] },
      mapped: { type: "choice", instructions: { ask: "Team?" }, criteria: { billing: null, tech: ["bugs", null] } },
      scored: { type: "score", instructions: "Urgency?", criteria: ["low", "high"] },
    },
  });
  same<typeof d.answers.bare, NoulAnswer>();
  same<typeof d.answers.listed.choice, "calm" | "angry">();
  same<typeof d.answers.mapped.choice, "billing" | "tech">();
  same<typeof d.answers.scored.legend, { readonly 0: "low"; readonly 1: "high" }>();
}

export function shapes(): void {
  noul();
  noul(null);
  choice(undefined, { yes: null, no: null });
  score(null, ["low", "high"]);
  kai.decide({ state: "s", questions: { q: { type: "noul" }, c: { type: "choice", criteria: ["a", "b"] } } });
  // @ts-expect-error instructions are text, an object or a list
  noul(3);
  // @ts-expect-error state cannot be null
  kai.decide({ state: null, questions: { q: noul("q?") } });
  // @ts-expect-error a number is not a description
  choice("Team?", { billing: 1 });
  // @ts-expect-error score criteria are a list
  score("Risk?", { 0: "low", 1: "high" });
  // @ts-expect-error a score needs a level
  score("Risk?", []);
  // @ts-expect-error a score level cannot be null
  score("Risk?", ["low", null]);
  const dynamic: string[] = ["low", "high"];
  // @ts-expect-error a string[] may be empty
  score("Risk?", dynamic);
  // @ts-expect-error noul criteria are keyed true and false
  noul("Spam?", { yes: "junk" });

  choice("Team?", ["billing", "tech"]);
  choice(["Team?", { context: "support" }], { billing: { examples: ["refund"] }, tech: null });
  score("Risk?", ["low"]);
  noul("Spam?", null);
  noul("Spam?", { true: null, false: { examples: ["hello"] } });
  same<ReturnType<typeof noul>, NoulQuestion>();
  const q: Question = choice("Which?", { a: null });
  void q;
  same<ReturnType<typeof choice<readonly ["x"]>>, ChoiceQuestion<readonly ["x"]>>();
}

export function promises(): void {
  const p = kai.decide({ state: "s", questions: { a: noul("a?") } });
  same<typeof p, APIPromise<Decision<{ readonly a: NoulQuestion }>>>();
  same<ReturnType<typeof p.withResponse>, Promise<WithResponse<Decision<{ readonly a: NoulQuestion }>>>>();
  same<ReturnType<typeof p.asResponse>, Promise<Response>>();
  same<ReturnType<typeof kai.models.list>, APIPromise<Model[]>>();
  same<Decision["answers"][string], Answer>();
}

export async function settings(): Promise<void> {
  const models = await kai.models.list();
  same<Model, { readonly id: string; readonly owned_by: string; readonly created: number; readonly pricing: { readonly input: number; readonly output: number } }>();
  // @ts-expect-error a model is read-only
  models[0]!.id = "x";
  // @ts-expect-error the client's settings are read-only
  kai.model = "x";
  // @ts-expect-error the policy is read-only
  kai.retry.maxRetries = 0;
  same<typeof kai.retry, RetryPolicy>();
  same<typeof kai.retry.httpStatuses, ReadonlySet<number>>();

  kai.models.list({ retry: { httpStatuses: new Set([503]), backoffJitter: 0 }, timeout: 5000, signal: AbortSignal.timeout(1000) });
  // @ts-expect-error statuses are a Set
  kai.models.list({ retry: { httpStatuses: [503] } });
  // @ts-expect-error no such policy field
  kai.models.list({ retry: { predicate: () => true } });
  // @ts-expect-error retries are set under retry
  kai.models.list({ maxRetries: 0 });
  // @ts-expect-error the key is private
  kai.apiKey;
}

declare const jev: Client;

export async function compatible(): Promise<void> {
  const r = await jev.systemOne({
    state: "s",
    questions: { a: noul("x"), b: jevChoice("y", { yes: null, no: "desc" }), c: score("z", ["bad", "ok"]) },
  });
  same<typeof r.answers.a, NoulResponse>();
  same<NoulResponse, { readonly type: "noul"; readonly noul: number }>();
  same<typeof r.answers.b, ChoiceResponse<{ readonly yes: null; readonly no: "desc" }>>();
  same<typeof r.answers.b.choice, "yes" | "no">();
  same<typeof r.answers.b.probabilities, { readonly yes: number; readonly no: number }>();
  same<typeof r.answers.c, ScoreResponse<readonly ["bad", "ok"]>>();
  same<typeof r.answers.c.legend, { readonly 0: "bad"; readonly 1: "ok" }>();
  same<typeof r.model, string>();
  same<typeof r.usage, Usage>();
  // @ts-expect-error Jev's noul carries P(true) alone
  r.answers.a.confidence;
  // @ts-expect-error nor answer_confidence on a choice
  r.answers.b.answer_confidence;
  // @ts-expect-error no Kai metadata on this path
  r.routing;
  // @ts-expect-error no such question
  r.answers.d;
  const cards = await jev.models.list();
  same<typeof cards, ModelCard[]>();
  same<ModelCard, { readonly name: string; readonly description: string; readonly release_date: string }>();
  const p = jev.systemOne({ state: "s", questions: { a: noul("a?") } });
  same<typeof p, APIPromise<Result<{ readonly a: NoulQuestion }>>>();
  same<typeof jev.defaultModel, string>();
  // @ts-expect-error the native call is not on this client
  jev.decide;
}
