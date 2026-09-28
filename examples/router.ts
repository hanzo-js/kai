// Route a request to a model or a tool from fixed sets. Kai selects; the host authorizes; nothing runs here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Kai, choice, type Questions } from "@hanzo/kai";

const PIN = "https://raw.githubusercontent.com/hanzoai/benchmarks/039fbfe5fa5dcb1483407594d829fa822d78974a/decision/results";
const N = 50;
const SEED = 7;

// Models: the harness's domain question, then a table from domain to model. Unsure -> the default model.
const DOMAINS = {
  code: "software engineering, programming, refactoring, architecture, debugging",
  math_or_logic: "mathematics, logic puzzles, proofs, complex calculation",
  writing: "creative writing, essays, emails, blog posts, copywriting",
  factual_lookup: "facts, definitions, trivia, history",
  data_analysis: "statistics, SQL, data manipulation, metrics",
  chitchat: "casual conversation, greetings, small talk",
} as const;
type Domain = keyof typeof DOMAINS;
const domain = choice("What domain does `request` belong to?", DOMAINS);
const MODEL: Record<Domain, string> = {
  code: "zen6", math_or_logic: "zen6", data_analysis: "zen5",
  writing: "zen5", factual_lookup: "zen5-mini", chitchat: "zen5-mini",
};
const DEFAULT = "zen5";
const MODEL_FLOOR = 0.6;

// Tools: a closed set with a way out. Unsure -> ask the user; no tool is picked.
const TOOLS = {
  search_docs: "look up how the product works in its documentation",
  query_metrics: "read numbers such as signups, revenue or usage from the analytics store",
  open_ticket: "file a bug report or a request for the engineering team",
  send_email: "send an email on the user's behalf",
  none: "answer from the conversation alone; no tool is needed",
} as const;
type Tool = keyof typeof TOOLS;
const tool = choice("Which tool should handle `request`?", TOOLS);
const TOOL_FLOOR = 0.7;
// The host's policy, not the model's: which tools run on a pick and which wait for the user.
const GRANT: Record<Tool, "run" | "confirm"> = {
  search_docs: "run", query_metrics: "run", open_ticket: "run", send_email: "confirm", none: "run",
};

// Requests and the tool their author expects; "unclear" expects a question back.
const REQUESTS: [string, Tool | "unclear"][] = [
  ["How do I rotate my API key?", "search_docs"],
  ["How many new signups did we get last week?", "query_metrics"],
  ["The CSV export button crashes the page every time. Can someone fix it?", "open_ticket"],
  ["Email the March invoice to finance@acme.example.", "send_email"],
  ["What is 15% of 240?", "none"],
  ["Can you take care of the thing from yesterday?", "unclear"],
];

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

  const suite: [{ request: string }, Questions, Record<string, { idx: number }>][] = (await load("states.json.gz"))["app.model_routing_domain"];
  const asked = suite[0][1].domain;
  if (asked.instructions !== domain.instructions || JSON.stringify(asked.criteria) !== JSON.stringify(DOMAINS))
    throw new Error("app.model_routing_domain asks a different question than this script");
  const labels = Object.keys(DOMAINS) as Domain[];
  let right = 0, routed = 0, routedRight = 0;
  const use = new Map<string, number>();
  for (const i of sample(suite.length, N, SEED)) {
    const [state, , gold] = suite[i];
    const a = (await kai.decide({ state, questions: { domain } })).answers.domain;
    const sure = a.confidence >= MODEL_FLOOR;
    const model = sure ? MODEL[a.choice] : DEFAULT;
    use.set(model, (use.get(model) ?? 0) + 1);
    right += +(a.choice === labels[gold.domain.idx]);
    routed += +sure;
    routedRight += +(sure && a.choice === labels[gold.domain.idx]);
  }
  console.log(`app.model_routing_domain, ${N} requests, seed ${SEED}: domain accuracy ${(right / N).toFixed(2)} (${right}/${N})`);
  console.log(`  confidence >= ${MODEL_FLOOR}: ${routed} routed by domain (${routedRight} right), ${N - routed} to ${DEFAULT}`);
  console.log(`  models used: ${[...use].map(([m, n]) => `${m} ${n}`).join(", ")}`);

  console.log("\nrequest".padEnd(74) + "pick".padEnd(15) + "conf  outcome");
  let ok = 0, stopped = 0;
  for (const [request, want] of REQUESTS) {
    const a = (await kai.decide({ state: { request }, questions: { tool } })).answers.tool;
    const sure = a.confidence >= TOOL_FLOOR;
    const outcome =
      !sure ? "ask the user what they need; no tool"
      : GRANT[a.choice] === "confirm" ? `hold ${a.choice} until the user confirms`
      : a.choice === "none" ? "answer directly"
      : `hand ${a.choice} to the host's executor`;
    const right = want === "unclear" ? !sure : a.choice === want;
    ok += +right;
    stopped += +(!right && !sure);
    console.log(request.padEnd(73) + a.choice.padEnd(15) + a.confidence.toFixed(2).padEnd(6) + outcome + (right ? "" : `  (want: ${want})`));
  }
  const missed = REQUESTS.length - ok;
  console.log(`${ok} of ${REQUESTS.length} as expected; ${stopped} of ${missed} misses stopped at the floor, ${missed - stopped} passed it`);
}

main();
