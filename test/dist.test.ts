import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as esm from "@hanzo/kai";
import * as jev from "@hanzo/kai/jev";
import { DECISION, json, scripted } from "./fetch.ts";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  version: string;
  exports: Record<string, Record<string, Record<string, string>> | string>;
};
const require = createRequire(import.meta.url);
const cjs = require("@hanzo/kai") as typeof esm;
const cjsJev = require("@hanzo/kai/jev") as typeof jev;

const VALUES = [
  "APIConnectionError",
  "APIError",
  "APIPromise",
  "APITimeoutError",
  "APIUserAbortError",
  "AuthenticationError",
  "BadRequestError",
  "ENV",
  "InternalServerError",
  "Kai",
  "KaiError",
  "LOG_LEVELS",
  "NotFoundError",
  "PaymentRequiredError",
  "PermissionDeniedError",
  "RateLimitError",
  "UnprocessableEntityError",
  "VERSION",
  "choice",
  "noul",
  "score",
];

const JEV = [...VALUES.filter((v) => v !== "Kai"), "Client"].sort();

test("the package by name, as ESM and as CommonJS, exports the same values", () => {
  assert.deepEqual(Object.keys(esm).sort(), VALUES);
  assert.deepEqual(Object.keys(cjs).sort(), VALUES);
  assert.deepEqual(Object.keys(jev).sort(), JEV);
  assert.deepEqual(Object.keys(cjsJev).sort(), JEV);
  assert.equal(esm.VERSION, pkg.version);
  assert.equal(cjs.VERSION, pkg.version);
  assert.equal(jev.VERSION, pkg.version);
});

test("@hanzo/kai/jev required as CommonJS posts to /v1/systemone", async () => {
  const body = { model: "kai-a7", answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 5, output_tokens: 0 } };
  const { fetch, calls } = scripted(() => json(body));
  const r = await new cjsJev.Client({ apiKey: "sk-test", fetch }).systemOne({ state: "s", questions: { q: cjsJev.noul("q?") } });
  assert.equal(r.answers.q.noul, 0.7);
  assert.ok(calls[0]?.url.endsWith("/v1/systemone"));
  assert.equal(cjsJev.APIError, cjs.APIError);
});

test("a CommonJS require makes a typed round trip and throws its own error classes", async () => {
  const { fetch, calls } = scripted(() => json(DECISION, 200, { "x-request-id": "req_cjs" }));
  const kai = new cjs.Kai({ apiKey: "sk-test", fetch });
  const { data, requestId } = await kai
    .decide({ state: "s", questions: { team: cjs.choice("Which team?", { billing: "charges", tech: "bugs" }) } })
    .withResponse();
  assert.equal(data.answers.team.choice, "billing");
  assert.equal(requestId, "req_cjs");
  assert.equal(calls[0]?.headers.get("user-agent"), `@hanzo/kai/${pkg.version}`);

  const failing = new cjs.Kai({ apiKey: "sk-test", fetch: scripted(() => json({}, 429)).fetch, retry: { maxRetries: 0 } });
  const error = await failing.models.list().catch((e: unknown) => e);
  assert.ok(error instanceof cjs.RateLimitError);
  assert.ok(error instanceof cjs.APIError);
  assert.ok(error instanceof cjs.KaiError);
});

test("every file the exports map names exists, and the CommonJS half says it is CommonJS", () => {
  for (const entry of [".", "./jev"]) {
    const conditions = pkg.exports[entry] as Record<string, Record<string, string>>;
    for (const kind of ["import", "require"]) {
      for (const path of Object.values(conditions[kind] ?? {})) assert.ok(existsSync(new URL(path, root)), path);
    }
  }
  const cjsPkg = JSON.parse(readFileSync(new URL("dist/cjs/package.json", root), "utf8"));
  assert.deepEqual(cjsPkg, { type: "commonjs" });
});

test("the built code imports nothing from Node, so it runs wherever fetch does", () => {
  for (const dir of ["dist/esm/", "dist/cjs/"]) {
    for (const file of readdirSync(new URL(dir, root)).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(new URL(dir + file, root), "utf8");
      assert.doesNotMatch(code, /from\s+["']node:|require\(["']node:|from\s+["'](fs|path|http|https|crypto)["']/, file);
    }
  }
});
