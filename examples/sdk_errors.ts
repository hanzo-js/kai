// Two refusals: a model that does not exist, and a key that does not resolve.
import { APIError, Kai, noul } from "@hanzo/kai";

const questions = {
  spam: noul("`message` is unsolicited advertising.", {
    true: "it sells something nobody asked for",
    false: "it is a message someone meant to send",
  }),
};

for (const [kai, model] of [
  [new Kai(), "kai-0"],
  [new Kai({ apiKey: "sk-not-a-key" }), "kai"],
] as const) {
  try {
    await kai.decide({ state: { message: "Win a free cruise, reply now" }, questions, model });
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    console.log(e.name, e.status, e.code, e.requestId);
    console.log(" ", e.message);
  }
}
