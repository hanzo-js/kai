// A program written for TypeSafe's SDK, answered by Kai: the import is the only change.
import { APIError, choice, noul, score, Client as TypeSafeClient } from "@hanzo/kai/jev";

const client = new TypeSafeClient();
const state = { ticket: "I was charged twice for my March invoice. Please refund the duplicate." };
const questions = {
  team: choice("Which team should handle `ticket`?", {
    billing: "charges, invoices and refunds",
    technical: "bugs, errors and outages",
  }),
  refund: noul("`ticket` asks for money back.", {
    true: "a refund or reversal is requested",
    false: "no money is requested back",
  }),
  urgency: score("How urgent is `ticket`?", ["later", "this week", "today", "now"]),
};

for (const model of ["kai", "jev-latest"]) {
  try {
    const r = await client.systemOne({ state, questions, model });
    console.log(r.model, JSON.stringify(r.answers), r.usage);
  } catch (e) {
    if (!(e instanceof APIError)) throw e;
    console.log(model, e.name, e.status, e.message);
  }
}
console.log(await client.models.list());
