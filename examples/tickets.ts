// Support triage with Kai: accuracy on sampled harness tickets, then one ticket walked end to end.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Kai, choice, score, type Questions } from "@hanzo/kai";

const PIN = "https://raw.githubusercontent.com/hanzoai/benchmarks/039fbfe5fa5dcb1483407594d829fa822d78974a/decision/results";
const N = 50;
const SEED = 7;
const FLOOR = 0.5; // an answer below this confidence goes to a person

// The harness's own queue question, so the accuracy below is the harness's.
const QUEUES = {
  "Technical Support": "technical problems, bugs, outages, integrations",
  "Product Support": "help using a product or feature",
  "Customer Service": "general account or service questions",
  "IT Support": "internal IT, devices, access, networks",
  "Billing and Payments": "invoices, charges, refunds, payment methods",
  "Returns and Exchanges": "returning or exchanging an item",
  "Service Outages and Maintenance": "downtime, outages, scheduled maintenance",
  "Sales and Pre-Sales": "pricing, quotes, buying",
  "Human Resources": "employment, payroll, leave, hiring",
  "General Inquiry": "anything else",
} as const;
type Queue = keyof typeof QUEUES;

const LEVELS = [
  "within a few days: a question or request with no deadline",
  "within a day: something is degraded or a deadline is near",
  "within hours: the customer cannot work or is losing money",
  "now: an outage, data loss or a security problem",
] as const;

const queue = choice("Which support queue should handle this ticket?", QUEUES);
const urgency = score("How soon does this ticket need a first reply?", LEVELS);
const wants = choice("What does the customer ask for?", {
  refund: "money back: a refund, a credit or a reversed charge",
  fix: "a problem fixed",
  answer: "information or an explanation",
  change: "a change to an account, a plan or an order",
});

// Adding a queue without a desk is a compile error: the answer's type is the label union.
const DESK: Record<Queue, string> = {
  "Technical Support": "eng", "IT Support": "eng", "Service Outages and Maintenance": "eng",
  "Product Support": "success", "Customer Service": "success", "General Inquiry": "success",
  "Billing and Payments": "billing", "Returns and Exchanges": "billing",
  "Sales and Pre-Sales": "sales", "Human Resources": "people",
};
const REPLY = ["3 days", "24 hours", "4 hours", "1 hour"];

type Case = [state: { subject: string; body: string }, questions: Questions, gold: Record<string, { idx: number }>];

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
  const suite: Case[] = (await load("states.json.gz"))["app.support_triage"];
  const asked = suite[0][1].queue;
  if (asked.instructions !== queue.instructions || JSON.stringify(asked.criteria) !== JSON.stringify(QUEUES))
    throw new Error("app.support_triage asks a different queue question than this script");
  const labels = Object.keys(QUEUES) as Queue[];

  const rows: { i: number; gold: Queue; pick: Queue; confidence: number }[] = [];
  for (const i of sample(suite.length, N, SEED)) {
    const [state, , gold] = suite[i];
    const d = await kai.decide({ state, questions: { queue } });
    rows.push({ i, gold: labels[gold.queue.idx], pick: d.answers.queue.choice, confidence: d.answers.queue.confidence });
  }

  const right = (rs: typeof rows) => rs.filter((r) => r.pick === r.gold).length;
  console.log(`app.support_triage, ${N} tickets, seed ${SEED}: accuracy ${(right(rows) / N).toFixed(2)} (${right(rows)}/${N})`);
  const common = labels.map((l) => [l, rows.filter((r) => r.gold === l).length] as const).reduce((x, y) => (y[1] > x[1] ? y : x));
  console.log(`  baseline: always "${common[0]}", the sample's most common queue, gets ${common[1]}/${N}`);
  for (const floor of [FLOOR, 0.8]) {
    const kept = rows.filter((r) => r.confidence >= floor);
    const acc = kept.length ? (right(kept) / kept.length).toFixed(2) : "-";
    console.log(`  confidence >= ${floor}: ${kept.length} routed, accuracy ${acc}; ${N - kept.length} to a person`);
  }
  const misses = new Map<string, number>();
  for (const r of rows) if (r.pick !== r.gold) misses.set(`${r.gold} -> ${r.pick}`, (misses.get(`${r.gold} -> ${r.pick}`) ?? 0) + 1);
  console.log("  most frequent misses, gold -> Kai:");
  for (const [pair, n] of [...misses].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`    ${n}  ${pair}`);

  // One ticket, three typed questions in one call: the first sampled billing ticket.
  const walk = rows.find((r) => r.gold === "Billing and Payments") ?? rows[0];
  const ticket = suite[walk.i][0];
  const d = await kai.decide({ state: ticket, questions: { queue, urgency, wants } });
  const { queue: q, urgency: u, wants: w } = d.answers;
  const top = Object.entries(u.probabilities).reduce((x, y) => (y[1] > x[1] ? y : x));
  const act = (confidence: number, then: string) => (confidence >= FLOOR ? then : "a person decides");
  console.log(`\nticket ${walk.i}, "${ticket.subject}" (gold: ${walk.gold})`);
  console.log(`  queue    ${q.choice}, confidence ${q.confidence.toFixed(3)} -> ${act(q.confidence, `desk ${DESK[q.choice]}`)}`);
  console.log(`  urgency  "${LEVELS[+top[0]].split(":")[0]}" at p ${top[1].toFixed(2)}, expected level ${u.score.toFixed(2)}, confidence ${u.confidence.toFixed(3)} -> ${act(u.confidence, `first reply within ${REPLY[+top[0]]}`)}`);
  console.log(`  wants    ${w.choice} at p ${w.probabilities[w.choice].toFixed(2)}, confidence ${w.confidence.toFixed(3)} -> ${act(w.confidence, w.choice === "refund" ? "open a refund review" : "no refund review")}`);
  console.log(`  usage    ${d.usage.input_tokens} input tokens, ${d.usage.output_tokens} output tokens`);
}

main();
