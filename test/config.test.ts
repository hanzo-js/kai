import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ENV, Kai, KaiError, LOG_LEVELS, noul } from "@hanzo/kai";
import { DECISION, json, scripted } from "./fetch.ts";

const saved = { ...process.env };

beforeEach(() => {
  for (const name of Object.values(ENV)) delete process.env[name];
});

afterEach(() => {
  process.env = { ...saved };
});

test("ENV names the four variables", () => {
  assert.deepEqual(ENV, {
    apiKey: "HANZO_API_KEY",
    baseURL: "HANZO_BASE_URL",
    model: "KAI_MODEL",
    logLevel: "KAI_LOG_LEVEL",
  });
  assert.deepEqual(LOG_LEVELS, ["debug", "info", "warn", "error", "off"]);
});

test("with nothing set: api.hanzo.ai, model kai, level warn, 60 s", () => {
  const kai = new Kai({ apiKey: "sk-test" });
  assert.equal(kai.baseURL, "https://api.hanzo.ai");
  assert.equal(kai.model, "kai");
  assert.equal(kai.logLevel, "warn");
  assert.equal(kai.timeout, 60000);
  assert.deepEqual(kai.defaultHeaders, {});
});

test("each setting is read from its variable", async () => {
  process.env.HANZO_API_KEY = " sk-env ";
  process.env.HANZO_BASE_URL = "https://env.test//";
  process.env.KAI_MODEL = "hanzo/kai";
  process.env.KAI_LOG_LEVEL = "error";
  const { fetch, calls } = scripted(() => json(DECISION));
  const kai = new Kai({ fetch });
  assert.equal(kai.baseURL, "https://env.test");
  assert.equal(kai.model, "hanzo/kai");
  assert.equal(kai.logLevel, "error");
  await kai.decide({ state: "s", questions: { q: noul("q?") } });
  assert.equal(calls[0]?.url, "https://env.test/v1/decisions");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer sk-env");
  assert.equal((calls[0]?.body as { model: string }).model, "hanzo/kai");
});

test("an option beats its variable", () => {
  process.env.HANZO_API_KEY = "sk-env";
  process.env.HANZO_BASE_URL = "https://env.test";
  process.env.KAI_MODEL = "env-model";
  process.env.KAI_LOG_LEVEL = "error";
  const kai = new Kai({ apiKey: "sk-code", baseURL: "https://code.test/", model: "kai", logLevel: "debug" });
  assert.equal(kai.baseURL, "https://code.test");
  assert.equal(kai.model, "kai");
  assert.equal(kai.logLevel, "debug");
});

test("blank variables count as unset", () => {
  process.env.HANZO_API_KEY = "sk-env";
  process.env.HANZO_BASE_URL = "  ";
  process.env.KAI_MODEL = "";
  process.env.KAI_LOG_LEVEL = " ";
  const kai = new Kai();
  assert.equal(kai.baseURL, "https://api.hanzo.ai");
  assert.equal(kai.model, "kai");
  assert.equal(kai.logLevel, "warn");
});

test("no key anywhere is refused, naming the variable", () => {
  assert.throws(() => new Kai(), { name: "KaiError", message: "no API key: pass apiKey, or set HANZO_API_KEY" });
  process.env.HANZO_API_KEY = "   ";
  assert.throws(() => new Kai(), KaiError);
  assert.throws(() => new Kai({ apiKey: "" }), KaiError);
});

test("an unknown log level is refused, naming where it came from", () => {
  process.env.KAI_LOG_LEVEL = "loud";
  assert.throws(() => new Kai({ apiKey: "k" }), {
    name: "KaiError",
    message: 'log level "loud" from KAI_LOG_LEVEL is not one of debug, info, warn, error, off',
  });
  assert.throws(() => new Kai({ apiKey: "k", logLevel: "verbose" as never }), /from the logLevel option/);
  for (const level of LOG_LEVELS) assert.equal(new Kai({ apiKey: "k", logLevel: level }).logLevel, level);
});

test("the key stays off the instance", () => {
  const kai = new Kai({ apiKey: "sk-secret-0123456789" });
  assert.equal("apiKey" in kai, false);
  assert.equal(Object.values(kai).includes("sk-secret-0123456789"), false);
  assert.equal(JSON.stringify(kai).includes("sk-secret"), false);
});

test("a browser page is refused unless dangerouslyAllowBrowser is set", (t) => {
  const g = globalThis as Record<string, unknown>;
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    delete g.window;
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else delete g.navigator;
  });
  g.window = { document: {} };
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0" }, configurable: true });
  assert.throws(() => new Kai({ apiKey: "sk-test" }), {
    name: "KaiError",
    message: /will not run in a browser page, where anyone using the page can read the API key/,
  });
  const kai = new Kai({ apiKey: "sk-test", dangerouslyAllowBrowser: true });
  assert.equal(kai.model, "kai");
});

test("a runtime without fetch needs one passed in", (t) => {
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  (globalThis as { fetch?: unknown }).fetch = undefined;
  assert.throws(() => new Kai({ apiKey: "sk-test" }), {
    name: "KaiError",
    message: "this runtime has no global fetch; pass one as the fetch option",
  });
  assert.equal(typeof new Kai({ apiKey: "sk-test", fetch: scripted(() => json(DECISION)).fetch }).fetch, "function");
});
