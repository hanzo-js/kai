// Runs every conformance rule against the live API and prints pass or fail per rule.
// After `npm run build`: HANZO_API_KEY=sk-... node scripts/conformance.mjs (HANZO_BASE_URL picks another host).
import { Kai } from "@hanzo/kai";
import { Client } from "@hanzo/kai/jev";
import { RULES } from "../test/conformance/rules.ts";

const key = process.env.HANZO_API_KEY;
if (!key) {
  console.error("set HANZO_API_KEY");
  process.exit(2);
}
// Waits out 429 and 529 as the API asks, so a rate limit is never read as a rule; every other status is a result.
const retry = { maxRetries: 10, httpStatuses: new Set([429, 529]) };
const make = (apiKey) => ({ kai: new Kai({ apiKey, retry }), jev: new Client({ apiKey, retry }) });
const clients = { ...make(key), strangers: make("sk-conformance-stranger") };

let failed = 0;
for (const rule of RULES) {
  const failures = await rule.check(clients);
  if (failures.length > 0) failed++;
  console.log(`${failures.length > 0 ? "FAIL" : "pass"}  ${rule.name}`);
  for (const f of failures) console.log(`      ${f}`);
}
console.log(`${RULES.length - failed} of ${RULES.length} rules pass against ${clients.kai.baseURL}`);
process.exitCode = failed > 0 ? 1 : 0;
