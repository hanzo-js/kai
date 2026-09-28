// The parsed decision with its HTTP response, then the raw response alone.
import { Kai, score } from "@hanzo/kai";

const kai = new Kai();
const request = {
  state: "The export button does nothing since this morning's update, and the team cannot send reports.",
  questions: { severity: score("How severe is the problem in `state`?", ["cosmetic", "degraded", "blocked"]) },
};

const { data, response, requestId } = await kai.decide(request).withResponse();
console.log(response.status, requestId, data.answers.severity.score);

const raw = await kai.decide(request).asResponse();
console.log(raw.status, raw.headers.get("content-type"), Object.keys(await raw.json()));
