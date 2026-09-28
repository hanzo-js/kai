// Writing checks as separate typed questions: each check gets its own probability, threshold and flag.
import { Kai, choice, score } from "@hanzo/kai";

// Each check names the outcomes a text can have, never a bare yes and no.
const checks = {
  hedging: choice("How does the text state its claims?", {
    plain: "plainly, or with a qualifier only where it gives a reason for doubt",
    hedged: "softened by words like might, perhaps, somewhat or I think, with no reason for doubt given",
  }),
  lead: choice("Where does the text give its main point or request?", {
    first: "in the first two sentences",
    late: "after the first two sentences, or nowhere",
  }),
  filler: choice("What could be deleted from the text without losing meaning?", {
    nothing: "nothing: every phrase carries information",
    padding: "throat-clearing such as 'it is worth mentioning', 'at the end of the day' or 'basically'",
  }),
  passive: choice("How does the text say who does what?", {
    named: "the sentences name who acts",
    hidden: "several actions have no named actor, as in 'mistakes were made' or 'it was decided'",
  }),
  tone: choice("Which register does the text keep?", {
    plain: "direct and neutral throughout",
    formal: "formal throughout",
    casual: "relaxed and conversational throughout",
    mixed: "switches between formal and casual",
  }),
  next: score("How clearly does the text say what the reader should do next?", [
    "it asks the reader for nothing",
    "it asks for something, but not who should act or by when",
    "it asks for something and says who acts or by when",
    "it asks for something and says who acts and by when",
  ]),
};
type Check = keyof typeof checks;

// Each 429 waits out its Retry-After, up to 10 times: a run of calls can meet the rate limit.
const kai = new Kai({ retry: { maxRetries: 10 } });
const ask = async (text: string) => (await kai.decide({ state: { text }, questions: checks })).answers;

// P(issue) for each check, read from its own typed answer; which side is the issue differs by check.
const issue = (a: Awaited<ReturnType<typeof ask>>): Record<Check, number> => ({
  hedging: a.hedging.probabilities.hedged,
  lead: a.lead.probabilities.late,
  filler: a.filler.probabilities.padding,
  passive: a.passive.probabilities.hidden,
  tone: a.tone.probabilities.mixed,
  next: a.next.probabilities["0"] + a.next.probabilities["1"],
});
const threshold: Record<Check, number> = { hedging: 0.5, lead: 0.5, filler: 0.5, passive: 0.5, tone: 0.5, next: 0.5 };

// Three texts and the issues their author wrote into them.
const TEXTS: Record<string, { text: string; want: Check[] }> = {
  hedged: {
    text: "I think we might be more or less ready to ship the new billing page at some point next week, although it's worth mentioning that a few things could possibly still come up. At the end of the day, mistakes were made in the last release, and it was decided that more testing would be done. Anyway, let me know what you think, no rush lol.",
    want: ["hedging", "filler", "passive", "tone", "next"],
  },
  crisp: {
    text: "The new billing page ships on Tuesday at 10:00 UTC. Load tests passed at twice last month's peak traffic. Dana owns the rollout and will post a go or no-go in #billing by Monday at 17:00. Please read the migration notes before Friday.",
    want: [],
  },
  buried: {
    text: "Over the last quarter a number of options regarding our monitoring setup have been looked at by the team. Several alerts were found to be misconfigured, and a review of the on-call logs was carried out. Various vendors were compared on price, coverage and support. Ultimately, approval is needed for a $4,000 annual monitoring budget.",
    want: ["lead", "passive", "next"],
  },
};

async function main() {
  const p: Record<string, Record<Check, number>> = {};
  for (const [name, { text }] of Object.entries(TEXTS)) p[name] = issue(await ask(text));

  const names = Object.keys(checks) as Check[];
  console.log("P(issue) per check and text; * flagged at the check's threshold; 'want' = written in on purpose");
  console.log(("check".padEnd(10) + "thr".padEnd(6) + Object.keys(TEXTS).map((t) => t.padEnd(14)).join("")).trimEnd());
  for (const c of names) {
    const cells = Object.entries(TEXTS).map(([t, { want }]) =>
      `${p[t][c].toFixed(2)}${p[t][c] >= threshold[c] ? "*" : " "} ${want.includes(c) ? "want" : ""}`.padEnd(14));
    console.log((c.padEnd(10) + threshold[c].toFixed(2).padEnd(6) + cells.join("")).trimEnd());
  }

  // Moving a threshold re-flags from the answers already held: no new call.
  const wanted = Object.values(TEXTS).reduce((n, t) => n + t.want.length, 0);
  for (const at of [0.3, 0.5, 0.7]) {
    let caught = 0, extra = 0;
    for (const [t, { want }] of Object.entries(TEXTS))
      for (const c of names) if (p[t][c] >= at) want.includes(c) ? caught++ : extra++;
    console.log(`every threshold at ${at}: ${caught} of ${wanted} written-in issues flagged, ${extra} other flags`);
  }
}

main();
