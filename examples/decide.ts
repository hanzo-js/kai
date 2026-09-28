// A support ticket through Kai: which team takes it, whether it is about billing, how urgent it is.
// From the repo root, after `npm run build`: HANZO_API_KEY=sk-... node examples/decide.ts
import { choice, Kai, noul, score } from "@hanzo/kai";

const kai = new Kai();

const ticket = {
  subject: "Charged twice for March",
  body: "My card shows two charges of $49 for the March invoice, and I only have one account. Please refund the duplicate.",
};

const d = await kai.decide({
  state: ticket,
  questions: {
    team: choice("Which team should handle this ticket?", {
      billing: "charges, invoices, refunds and payment methods",
      technical: "bugs, errors, outages and integrations",
      account: "sign-in, passwords and profile settings",
    }),
    billing: noul("This ticket is about billing.", {
      true: "it concerns charges, invoices or refunds",
      false: "it concerns something else",
    }),
    urgency: score("How urgent is this ticket?", ["can wait", "this week", "today", "right now"]),
  },
});

const { team, billing, urgency } = d.answers;
console.log("team    ", team.choice, `p=${team.probabilities[team.choice]}`, `confidence=${team.confidence}`);
console.log("billing ", `P(true)=${billing.noul}`);
console.log("urgency ", `expected level ${urgency.score} of 0 (${urgency.legend[0]}) to 3 (${urgency.legend[3]})`, urgency.probabilities);
console.log("decision", d.id, `model=${d.model}`, `input tokens=${d.usage.input_tokens}`);
