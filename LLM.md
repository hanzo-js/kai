# @hanzo/kai

TypeScript client for Kai decisions: `POST {base}/v1/decisions` and `GET {base}/v1/models`, base
`https://api.hanzo.ai`, Bearer auth with a Hanzo `sk-` key or an IAM access token. Zero runtime dependencies; ESM,
CommonJS and `.d.ts`; Node ≥ 20 or any runtime with `fetch`. Repo `hanzo-js/kai`, npm `@hanzo/kai`.

## Contract

The surface is shared with the Python `hanzo-kai` (same contract file, built in parallel); a name changes in both or
in neither. Type-level parity with TypeSafe's `@typesafe-ai/sdk` 0.6.0 under our names; none of its code or text.

- `new Kai({ apiKey, baseURL, model, timeout, retry, defaultHeaders, fetch, logger, logLevel, dangerouslyAllowBrowser })`;
  environment `HANZO_API_KEY`, `HANZO_BASE_URL`, `KAI_MODEL` (default `kai`), `KAI_LOG_LEVEL` (default `warn`).
- `kai.decide<const Q>({ state, questions, model?, session_id?, user?, trace?, provider?, ...sent as given },
  { signal, timeout, retry, headers })` returns `APIPromise<Decision<Q>>`: awaiting parses once;
  `.withResponse()` gives `{ data, response, requestId }`; `.asResponse()` the unread `Response`.
- Builders `choice(instructions, { label: description | null } | [label, …])`,
  `noul(instructions?, { true?, false? }?, labels?)` (`NoulLabels` `{ true, false }`: the words the two sides go by,
  /v1/decisions only), `score(instructions, [level0, …])`; labels and levels become literal types in the answers.
  Instructions are optional (a builder given `null` or `undefined` sends none); score levels are non-null in the types.
- `Decision`: `id`, `model`, `provider`, `answers`, `usage`, `routing`, `state_hash`, `latency_ms`. Answers:
  noul `noul`, `confidence` = |2p−1|; choice `choice`, `confidence`, `probabilities`; score `score`, `confidence`,
  `legend` and `probabilities` keyed `"0"`, `"1"`, …; all may carry `answer_confidence` and `action`. Unknown answer
  types are dropped with a warning; unknown fields are kept.
- `kai.models.list()`: entries of `GET /v1/models` whose `outputs` include `"decision"` (today `kai`, `hanzo/kai`).
- Client-side checks only: at least one question, score criteria a list, choice criteria a map or a list. Every
  other rule is the server's (contract.md, frozen): 1..=100 questions, a choice ≥ 2 labels, a score ≥ 1 level and
  no null level; `/v1/systemone` caps labels at 255 and levels at 10, native caps neither; schema errors are 422.
- Reach refusals are 422 with `code` a name, on both paths (native `error.code`, compat `detail[0].type`):
  `state_too_long` (state with a question over what the model reads; wire ceiling 128k tokens), `question_too_long`
  (a question with its type line over half the checkpoint's `max_len`), `option_too_long` (an option over 512
  tokens), `request_too_long` (a body over 16 MiB). Other errors carry the status as `code`.
- Model ids: `kai`, `hanzo/kai`, and the versioned `kai-<first 12 hex of the weights' sha256>` (from
  `routing.sha256`), taken on both paths; `/v1/systemone` answers `model` with the versioned id.
  `typesafe/jev-1.13` and `~typesafe/jev-latest` reach Jev through OpenRouter on both paths, billed at $0.042 per
  1M input tokens; bare Jev ids are 400 `Unknown model` on `/v1/systemone`.
- Errors: `KaiError` ⊃ `APIError` (`status`, `code`, `message` = the server's sentence, `requestId` from
  `x-request-id`, `body`, `retryAfter` in seconds, `headers`) with 400 `BadRequestError`, 401
  `AuthenticationError`, 402 `PaymentRequiredError`, 403 `PermissionDeniedError`, 404 `NotFoundError`, 422
  `UnprocessableEntityError`, 429 `RateLimitError`, ≥ 500 (529 overloaded) `InternalServerError`;
  `APIConnectionError` ⊃ `APITimeoutError`; `APIUserAbortError`. Bodies read: `{"error":{"code","message"}}`
  (native), `{"detail": "…" | [{loc, msg, type}]}` (compatible path; `code` is the first `type`),
  `{"error":{"message","type","code"}}` and `{"status":"error","msg"}` (gateway), text.
- Retries: 2 by default; 0.5 s doubling to 8 s less up to 25%; 408, 409, 429, 500–599, connection errors,
  timeouts; `retry-after-ms` then `Retry-After` (seconds or date) waited, capped at 60 s; `X-Kai-Retry-Count` on
  each retry. Timeout 60 s per attempt, body included.
- Headers: `User-Agent: @hanzo/kai/<version>`, `X-Kai-Runtime`. Logs (`[kai]` prefix): `info` one line per
  attempt, `debug` headers with `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key` masked,
  and bodies.
- Wire facts: with model `hanzo/kai` the gateway re-encodes the body with sorted keys, so everything is read by name.
- `@hanzo/kai/jev` (`src/jev.ts`, its own `exports` entry): `Client` with TypeSafe's `systemOne({state, questions, model?})`
  on `POST /v1/systemone`, `defaultModel` `kai`, Jev's answer shapes (`NoulResponse`, `ChoiceResponse`, `ScoreResponse`,
  `Result<Q>`), `models.list()` reading `data` (never the gateway's `models`, which stays `[]`) as Jev's cards:
  name = id, description empty, release_date = the UTC day of `created`; no TypeSafe brand name is exported.

## Layout

`src/client.ts` (Kai), `http.ts` (settings, the request and retry loop both clients share), `jev.ts`,
`promise.ts` (APIPromise), `types.ts`, `questions.ts` (builders, checks),
`errors.ts`, `retry.ts` (defaults, delay, sleep), `log.ts`, `env.ts`, `runtime.ts`, `json.ts`, `version.ts` (kept
equal to package.json by `test/dist.test.ts`). Build: `tsc` twice (`tsconfig.esm.json` → `dist/esm`,
`tsconfig.cjs.json` → `dist/cjs` plus a `{"type":"commonjs"}` package.json); sources import with `.js` so the
declarations resolve everywhere, and compile without Node types so nothing Node-only slips in.

## Test

`npm test`: build, `tsc -p tsconfig.json` over src, test and examples (`test/types.test-d.ts` holds the type-level
assertions and `@ts-expect-error` lines), then `node --test` (TAP) over `test/*.test.ts` through a scripted fetch,
no network. Tests import the built package by name, ESM and CommonJS, so they check what ships. Node's type
stripping runs them: Node ≥ 22.18. Run under `nice -n19 ionice -c3` on shared machines.

Conformance: `test/conformance/rules.ts` holds one check per contract rule, run through the SDK on both paths;
`offline.test.ts` runs them in `npm test` against `server.ts` (the contract as a scripted fetch), and
`scripts/conformance.mjs` (`npm run conformance`, needs `HANZO_API_KEY`) against the live API, pass or fail per rule.

## Release

Bump `version` in package.json and `src/version.ts`, push to main. `.github/workflows/cicd.yml` runs `hanzo.yml`'s
gate through `hanzoai/ci` build.yml@v2; `.github/workflows/publish.yml` publishes when npm lacks the version, with
`NPM_TOKEN` read from KMS through `KMS_CLIENT_ID`/`KMS_CLIENT_SECRET`, on label `linux-amd64`. Never publish by
hand. Check with `npm view @hanzo/kai version`. The lane needs, in the hanzo-js org: those two secrets (it holds only
a GitHub `NPM_TOKEN`), and a `linux-amd64` runner group that admits public repositories.
