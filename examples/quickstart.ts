import { Kai, choice, score } from "@hanzo/kai";

const kai = new Kai();
const d = await kai.decide({
  state: { message: "My new card arrived yesterday but the app will not activate it. It says the code is invalid, and I fly on Friday." },
  questions: {
    intent: choice("What does `message` ask for?", {
      activate_card: "turn on a new card",
      lost_card: "report a lost or stolen card",
      refund: "money back for a payment",
      transfer: "send or receive money",
      other: "anything else",
    }),
    urgency: score("How soon does `message` need an answer?", [
      "routine: no deadline",
      "soon: a deadline this week",
      "urgent: blocked now or losing money",
    ]),
  },
});

const { intent, urgency } = d.answers;
console.log(intent.choice, intent.confidence);
console.log(urgency.score, urgency.confidence, urgency.probabilities);
console.log(d.usage.input_tokens, d.routing?.checkpoint);
