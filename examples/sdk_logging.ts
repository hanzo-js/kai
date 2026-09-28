// Debug logging through a logger of your own; every credential in it is masked.
import { Kai, type Logger, noul } from "@hanzo/kai";

const lines: [string, ...unknown[]][] = [];
const keep = (message: string, ...args: unknown[]) => void lines.push([message, ...args]);
const logger: Logger = { debug: keep, info: keep, warn: keep, error: keep };

const kai = new Kai({ logger, logLevel: "debug", defaultHeaders: { "X-Api-Key": "xk-demo-0123456789" } });
await kai.decide({
  state: { message: "Win a free cruise, reply now" },
  questions: {
    spam: noul("`message` is unsolicited advertising.", {
      true: "it sells something nobody asked for",
      false: "it is a message someone meant to send",
    }),
  },
});

for (const [message] of lines) console.log(message);
const [, sent] = lines[0] as [string, { headers: Record<string, string> }];
console.log(sent.headers);
