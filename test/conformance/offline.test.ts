import assert from "node:assert/strict";
import { test } from "node:test";
import { Kai } from "@hanzo/kai";
import { Client } from "@hanzo/kai/jev";
import { type Clients, RULES } from "./rules.ts";
import { contract, KEY } from "./server.ts";

/** Both paths over one fake server that answers as the contract says. */
function clients(): Clients {
  const fetch = contract();
  const make = (apiKey: string) => ({
    kai: new Kai({ apiKey, fetch, retry: { maxRetries: 0 } }),
    jev: new Client({ apiKey, fetch, retry: { maxRetries: 0 } }),
  });
  return { ...make(KEY), strangers: make("sk-stranger") };
}

for (const rule of RULES) {
  test(`contract: ${rule.name}`, async () => {
    assert.deepEqual(await rule.check(clients()), []);
  });
}
