// A/B two ways: one question set over two versions of an input, and Kai live against Jev's recorded answers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Kai, choice, score, type EntryType, type Question, type Questions } from "@hanzo/kai";

const PIN = "https://raw.githubusercontent.com/hanzoai/benchmarks/039fbfe5fa5dcb1483407594d829fa822d78974a/decision/results";
const SUITES = ["jev.emotion", "app.guardrails_jailbreak", "app.rag_relevance"];
const PER = 20;
const SEED = 7;

// (a) The same questions over two drafts of one reply.
const questions = {
  tone: choice("How does `reply` sound to the customer?", {
    warm: "friendly and personal",
    neutral: "matter-of-fact",
    curt: "short, cold or dismissive",
  }),
  resolves: score("How far does `reply` get the customer toward a resolution?", [
    "it offers nothing",
    "it explains the situation but offers nothing",
    "it offers an alternative or a workaround",
    "it solves the problem",
  ]),
  next: choice("What will the customer most likely do after `reply`?", {
    accept: "accept it and move on",
    ask: "write back with a question",
    escalate: "complain again, dispute the charge or ask for a manager",
  }),
};
const complaint = "I was charged $49 for a yearly renewal I never asked for. I want my money back.";
const DRAFTS = {
  A: "Refunds are only possible within 30 days of purchase. Your renewal is outside that window.",
  B: "Sorry the renewal caught you off guard. It is past our 30-day refund window, so I can't refund it, but I've added a $20 credit to your account, and you can turn off renewal under Settings > Billing.",
};
// How the author reads each draft, A -> B, to hold Kai's shift against.
const READING = { tone: "curt -> warm", next: "escalate -> accept", resolves: "1 -> 2" };

type Case = [state: EntryType, questions: Questions, gold: Record<string, { idx: number }>];

// The harness's option order for a question: noul [false, true], score by level, choice by label.
const order = (q: Question): string[] =>
  q.type === "noul" ? ["false", "true"]
  : q.type === "score" ? q.criteria.map((_, i) => String(i))
  : Array.isArray(q.criteria) ? [...q.criteria] : Object.keys(q.criteria);
const argmax = (v: number[]) => v.indexOf(Math.max(...v));

async function load(file: string): Promise<any> {
  const dir = join(tmpdir(), "kai-cookbook");
  const path = join(dir, file.replace("/", "-"));
  if (!existsSync(path)) {
    const res = await fetch(`${PIN}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(gunzipSync(readFileSync(path)).toString());
}

// n indices of 0..size-1, shuffled by a seeded generator (mulberry32).
function sample(size: number, n: number, seed: number): number[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const idx = [...Array(size).keys()];
  for (let i = size - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n);
}

async function main() {
  // Each 429 waits out its Retry-After, up to 10 times: a run of calls can meet the rate limit.
  const kai = new Kai({ retry: { maxRetries: 10 } });

  const [a, b] = [
    (await kai.decide({ state: { complaint, reply: DRAFTS.A }, questions })).answers,
    (await kai.decide({ state: { complaint, reply: DRAFTS.B }, questions })).answers,
  ];
  type Pick = { choice: string; probabilities: Record<string, number> };
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
  const shown = (x: Pick) => `${x.choice} ${x.probabilities[x.choice].toFixed(2)}`;
  const moved = (x: Pick, y: Pick) =>
    Object.keys(x.probabilities).map((k) => [k, y.probabilities[k] - x.probabilities[k]] as const)
      .reduce((m, n) => (Math.abs(n[1]) > Math.abs(m[1]) ? n : m));
  console.log("question  " + "A".padEnd(18) + "B".padEnd(18) + "largest move".padEnd(18) + "author's reading");
  for (const [name, x, y] of [["tone", a.tone, b.tone], ["next", a.next, b.next]] as ["tone" | "next", Pick, Pick][]) {
    const [label, delta] = moved(x, y);
    console.log(name.padEnd(10) + shown(x).padEnd(18) + shown(y).padEnd(18) + `${label} ${sign(delta)}`.padEnd(18) + READING[name]);
  }
  console.log("resolves".padEnd(10) + `level ${a.resolves.score.toFixed(2)}`.padEnd(18) + `level ${b.resolves.score.toFixed(2)}`.padEnd(18) +
    sign(b.resolves.score - a.resolves.score).padEnd(18) + READING.resolves);

  // (b) Kai now against Jev's answers recorded on the same pinned cases.
  const states = await load("states.json.gz");
  const jev = (await load("jev/preds.json.gz")).suites;
  console.log("\nsuite".padEnd(27) + "n    Kai   Jev   agree  both  Kai-only  Jev-only  neither");
  const all = [0, 0, 0, 0, 0, 0];
  for (const suite of SUITES) {
    const cases: Case[] = states[suite];
    const t = [0, 0, 0, 0, 0, 0]; // n, Kai right, Jev right, agree, both right, neither
    for (const i of sample(cases.length, PER, SEED)) {
      const [state, qs, gold] = cases[i];
      const d = await kai.decide({ state, questions: qs });
      for (const [name, q] of Object.entries(qs)) {
        const ans = d.answers[name];
        const kv = ans.type === "noul" ? [1 - ans.noul, ans.noul] : order(q).map((k) => (ans.probabilities as Record<string, number>)[k]);
        const k = argmax(kv), j = argmax(jev[suite].p[`${i}/${name}`]), g = gold[name].idx;
        t[0]++; t[1] += +(k === g); t[2] += +(j === g); t[3] += +(k === j); t[4] += +(k === g && j === g); t[5] += +(k !== g && j !== g);
      }
    }
    t.forEach((x, n) => (all[n] += x));
    row(suite, t);
  }
  row("all", all);
}

function row(name: string, [n, k, j, agree, both, neither]: number[]) {
  const f = (x: number) => (x / n).toFixed(2).padEnd(6);
  console.log(name.padEnd(26) + String(n).padEnd(5) + f(k) + f(j) + f(agree) + " " + String(both).padEnd(6) +
    String(k - both).padEnd(10) + String(j - both).padEnd(10) + neither);
}

main();
