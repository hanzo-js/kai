// Three questions about one support ticket; each answer comes back typed by its question.
import { Kai, choice, noul, score } from "@hanzo/kai";

const kai = new Kai();

const d = await kai.decide({
  state: { ticket: "I was charged twice for my March invoice. Please refund the duplicate." },
  questions: {
    team: choice("Which team should handle `ticket`?", {
      billing: "charges, invoices and refunds",
      technical: "bugs, errors and outages",
      account: "sign-in and profile settings",
    }),
    refund: noul("`ticket` asks for money back.", {
      true: "a refund or reversal is requested",
      false: "no money is requested back",
    }),
    urgency: score("How urgent is `ticket`?", ["later", "this week", "today", "now"]),
  },
});

const { team, refund, urgency } = d.answers;
console.log(team.choice, team.confidence, team.probabilities);
console.log(refund.noul, refund.confidence);
console.log(urgency.score, urgency.legend[3], urgency.probabilities);
console.log(d.id, d.model, d.usage, d.routing.checkpoint);
