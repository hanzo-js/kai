import assert from "node:assert/strict";
import { test } from "node:test";
import { Kai, type LogLevel, noul, VERSION } from "@hanzo/kai";
import { DECISION, json, MODELS, recorder, said, scripted } from "./fetch.ts";

const KEY = "sk-live-0123456789abcdef";

function client(logLevel: LogLevel, respond = () => json(DECISION, 200, { "x-request-id": "req_7" })) {
  const log = recorder();
  const { fetch } = scripted(respond);
  const kai = new Kai({
    apiKey: KEY,
    baseURL: "https://api.test",
    fetch,
    logger: log,
    logLevel,
    defaultHeaders: { Cookie: "session=abc123", "X-Api-Key": "xk-999", "Proxy-Authorization": "Basic dXNlcjpwYXNz" },
  });
  return { kai, log };
}

test("the default level says nothing about a request that succeeds", async (t) => {
  const spies = (["debug", "info", "warn", "error"] as const).map((m) => t.mock.method(console, m, () => {}));
  const { fetch } = scripted(() => json(DECISION));
  await new Kai({ apiKey: KEY, fetch }).decide({ state: "s", questions: { q: noul("q?") } });
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test("the console logger prefixes each line [kai]", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const { fetch } = scripted(() => json(MODELS, 200, { "x-request-id": "req_7" }));
  await new Kai({ apiKey: KEY, fetch, logLevel: "info" }).models.list();
  assert.match(String(info.mock.calls[0]?.arguments[0]), /^\[kai\] #1 GET \/v1\/models <- 200 in \d+ ms \(request req_7\)$/);
});

test("info logs one line per attempt", async () => {
  const { kai, log } = client("info");
  await kai.decide({ state: "s", questions: { q: noul("q?") } });
  assert.equal(said(log, "debug").length, 0);
  assert.deepEqual(said(log, "info").length, 1);
  assert.match(said(log, "info")[0] ?? "", /^#1 POST \/v1\/decisions <- 200 in \d+ ms \(request req_7\)$/);
});

test("debug logs headers with every credential masked, and both bodies", async () => {
  const { kai, log } = client("debug");
  await kai.decide({ state: "s", questions: { q: noul("q?") } });
  const [level, message, detail] = log.lines[0] ?? [];
  assert.equal(level, "debug");
  assert.equal(message, "#1 POST /v1/decisions -> https://api.test/v1/decisions");
  const { headers, body } = detail as { headers: Record<string, string>; body: unknown };
  assert.equal(headers.authorization, "Bearer ***");
  assert.equal(headers["proxy-authorization"], "Basic ***");
  assert.equal(headers.cookie, "***");
  assert.equal(headers["x-api-key"], "***");
  assert.equal(headers["user-agent"], `@hanzo/kai/${VERSION}`);
  assert.deepEqual(body, { model: "kai", state: "s", questions: { q: { type: "noul", instructions: "q?" } } });
  assert.deepEqual(log.lines.at(-1)?.slice(0, 2), ["debug", "#1 POST /v1/decisions <- body"]);
  const everything = JSON.stringify(log.lines);
  for (const secret of [KEY, "abc123", "xk-999", "dXNlcjpwYXNz"]) assert.equal(everything.includes(secret), false, secret);
});

test("a failed attempt logs its error body at debug and its retry at info", async () => {
  let n = 0;
  const { kai, log } = client("debug", () =>
    n++ === 0 ? json({ error: { code: 503, message: "busy" } }, 503) : json(DECISION),
  );
  await kai.decide({ state: "s", questions: { q: noul("q?") } }, { retry: { backoffInitialMs: 0 } });
  assert.ok(log.lines.some((l) => l[1] === "#1 POST /v1/decisions <- error body" && JSON.stringify(l[2]).includes("busy")));
  assert.ok(said(log, "info").some((m) => /^#1 POST \/v1\/decisions retrying in 0 ms \(1\/2\) after 503$/.test(m)));
});

test("off drops everything, warnings included", async () => {
  const { kai, log } = client("off", () =>
    json({ ...DECISION, answers: { odd: { type: "rank" }, q: { type: "noul", noul: 0.5 } } }),
  );
  const d = await kai.decide({ state: "s", questions: { q: noul("q?") } });
  assert.deepEqual(Object.keys(d.answers), ["q"]);
  assert.deepEqual(log.lines, []);
});

test("the client's logger is the configured one narrowed to its level", () => {
  const { kai, log } = client("warn");
  kai.logger.debug("no");
  kai.logger.info("no");
  kai.logger.warn("yes");
  kai.logger.error("yes too");
  assert.deepEqual(
    log.lines.map((l) => l[1]),
    ["yes", "yes too"],
  );
});
