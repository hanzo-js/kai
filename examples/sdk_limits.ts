// Retry settings on the client, then a timeout and an abort on single calls.
import { APITimeoutError, APIUserAbortError, Kai, choice } from "@hanzo/kai";

const kai = new Kai({ retry: { maxRetries: 4, httpStatuses: new Set([429, 503, 529]) } });
console.log(kai.retry.maxRetries, [...kai.retry.httpStatuses], kai.timeout);

const state = { message: "Third time asking. Fix my login." };
const questions = { tone: choice("What is the tone of `message`?", { calm: null, frustrated: null, angry: null }) };

const d = await kai.decide({ state, questions }, { timeout: 30_000 });
console.log(d.answers.tone.choice);

try {
  await kai.decide({ state, questions }, { timeout: 1, retry: { maxRetries: 0 } });
} catch (e) {
  if (!(e instanceof APITimeoutError)) throw e;
  console.log(e.name, e.message);
}

try {
  await kai.decide({ state, questions }, { signal: AbortSignal.timeout(5) });
} catch (e) {
  if (!(e instanceof APIUserAbortError)) throw e;
  console.log(e.name, e.message);
}
