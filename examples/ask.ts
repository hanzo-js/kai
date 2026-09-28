// An ask gate for a community channel: answered above, answered in the docs, for a person, or too vague. Replies are templates.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kai, choice } from "@hanzo/kai";

const DOCS = "https://docs.hanzo.ai";
const K = 6;        // shortlisted pages per question
const FLOOR = 0.5;  // a route or a citation below this confidence goes to a person

type Passage = { id: string; kind: "message" | "page"; title: string; url: string; text: string };

// The channel, oldest first. `want` marks a message to gate and the route its author expects.
const CHANNEL: { id: string; who: string; text: string; want?: string }[] = [
  { id: "m1", who: "rosa", text: "Does Kai write text, or does it only answer the questions I send?" },
  { id: "m2", who: "dev", text: "Only answers: a probability for every option you give it. It generates nothing, so output tokens are always 0." },
  { id: "m3", who: "sam", text: "What does a Kai call cost?", want: "docs" },
  { id: "m4", who: "ines", text: "Can Kai also write the reply to my customer?", want: "answered" },
  { id: "m5", who: "kofi", text: "How do I rotate an API key?", want: "docs" },
  { id: "m6", who: "lee", text: "Our org was charged twice in August. Can someone refund one of the charges?", want: "person" },
  { id: "m7", who: "ana", text: "it's broken again", want: "context" },
  { id: "m8", who: "omar", text: "My /v1/decisions request comes back 402. What does that mean?", want: "docs" },
];

const route = choice("What should happen to `question`?", {
  answered: "a message in `earlier` already answers it",
  docs: "a page in `docs` answers it",
  person: "it needs someone with access to the account, or a decision only staff can make",
  context: "it is too vague to answer; the asker has to say more",
});

// Every page llms.txt lists is one passage: its title and its one-line description.
async function pages(): Promise<Passage[]> {
  const dir = join(tmpdir(), "kai-cookbook");
  if (!existsSync(join(dir, "llms.txt"))) {
    const res = await fetch(`${DOCS}/llms.txt`);
    if (!res.ok) throw new Error(`llms.txt: HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "llms.txt"), await res.text());
  }
  return readFileSync(join(dir, "llms.txt"), "utf8").split("\n").flatMap((line) => {
    const m = line.match(/^- \[(.+?)\]\((\/[^)]*)\)(?::\s*(.*))?$/);
    return m ? [{ id: "", kind: "page" as const, title: m[1], url: DOCS + m[2], text: m[3] ?? "" }] : [];
  });
}

// The shortlist: BM25 over each page's title and description.
const STOP = new Set("a an and are as at be but by can do does for from how i in is it its me my of on or our so that the this to what when which who why will with you your".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.replace(/s$/, ""));
function index(corpus: Passage[]) {
  const docs = corpus.map((p) => words(`${p.title} ${p.text}`));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  return (query: string): Passage[] => {
    const q = new Set(words(query));
    const bm25 = (d: string[]) => [...q].reduce((s, w) => {
      const f = d.filter((x) => x === w).length, n = df.get(w) ?? 0;
      return f ? s + Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg)) : s;
    }, 0);
    return corpus.map((p, i) => [p, bm25(docs[i])] as const).filter(([, s]) => s > 0)
      .sort((x, y) => y[1] - x[1]).slice(0, K).map(([p], i) => ({ ...p, id: `d${i + 1}` }));
  };
}

async function main() {
  // Each 429 waits out its Retry-After, up to 10 times: a run of calls can meet the rate limit.
  const kai = new Kai({ retry: { maxRetries: 10 } });
  const search = index(await pages());
  let asked = 0, matched = 0;
  for (const [n, msg] of CHANNEL.entries()) {
    if (!msg.want) continue;
    const earlier: Passage[] = CHANNEL.slice(0, n).map((m) => ({ id: m.id, kind: "message", title: m.who, url: "", text: m.text }));
    const found = search(msg.text);
    const passages = [...earlier, ...found];
    const source = choice("Which passage answers `question`?", {
      ...Object.fromEntries(passages.map((p) => [p.id, `${p.title}: ${p.text}`.slice(0, 200)])),
      none: "no passage answers it",
    });
    const state = {
      question: msg.text,
      earlier: earlier.map((m) => `${m.id} ${m.title}: ${m.text}`),
      docs: found.map((d) => `${d.id} ${d.title} (${d.url}): ${d.text}`),
    };
    const { route: r, source: s } = (await kai.decide({ state, questions: { route, source } })).answers;
    const cited = passages.find((p) => p.id === s.choice);
    const reply =
      r.confidence < FLOOR ? "to a person: the route is unsure"
      : r.choice === "person" ? "to a person"
      : r.choice === "context" ? "reply: which call did you make, what did you send, and what came back?"
      : !cited || s.confidence < FLOOR ? "to a person: no passage Kai stands behind"
      : r.choice === "answered" && cited.kind === "message" ? `reply: answered above, see ${cited.id}`
      : r.choice === "docs" && cited.kind === "page" ? `reply: see "${cited.title}", ${cited.url}`
      : "to a person: the route and the citation disagree";
    asked++;
    matched += +(r.choice === msg.want);
    console.log(`${msg.id} ${msg.who}: ${msg.text}`);
    console.log(`   route ${r.choice} ${r.confidence.toFixed(2)} (want ${msg.want}); cites ${s.choice} ${s.confidence.toFixed(2)}${cited ? ` "${cited.title}"` : ""}`);
    console.log(`   ${reply}`);
  }
  console.log(`${matched} of ${asked} routes as the author expected.`);
}

main();
