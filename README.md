# @hanzo/kai

TypeScript client for Kai decisions on `api.hanzo.ai`. Ask typed questions about a state — pick a label, judge a
statement, rate on a scale — and get calibrated probabilities back, each answer typed by the question that asked it.

Docs: https://docs.hanzo.ai/docs/kai · Moving from TypeSafe's Jev: https://docs.hanzo.ai/docs/guides/migrate/jev

## Install

```sh
npm i @hanzo/kai
```

ESM and CommonJS, types included, no dependencies. Node 20 or later, or any runtime with `fetch`.

## Quickstart

```ts
import { Kai, choice, noul, score } from "@hanzo/kai";

const kai = new Kai(); // reads HANZO_API_KEY

const d = await kai.decide({
  state: { subject: "Charged twice for March", body: "Two charges of $49 on my card. Please refund one." },
  questions: {
    team: choice("Which team should handle this ticket?", {
      billing: "charges, invoices, refunds and payment methods",
      technical: "bugs, errors, outages and integrations",
    }),
    billing: noul("This ticket is about billing.", {
      true: "it concerns charges, invoices or refunds",
      false: "it concerns something else",
    }),
    urgency: score("How urgent is this ticket?", ["can wait", "this week", "today", "right now"]),
  },
});

d.answers.team.choice; // "billing" | "technical"
d.answers.team.probabilities.billing; // 0 to 1
d.answers.billing.noul; // P(true)
d.answers.urgency.score; // expected level, 0 to 3
d.answers.urgency.legend[3]; // "right now"
```

`examples/decide.ts` runs this against the live API.

## Questions and answers

| builder | criteria | answer |
|---|---|---|
| `choice(instructions, criteria)` | `{ label: description \| null }` or `[label, …]` | `choice`, `confidence`, `probabilities` by label |
| `noul(instructions, criteria?)` | `{ true?: description, false?: description }` | `noul`: P(true) |
| `score(instructions, criteria)` | `[level0, level1, …]`, lowest first | `score`: Σ i·pᵢ; `confidence`; `legend` and `probabilities` keyed `"0"`, `"1"`, … |

`confidence` is (n·p_max − 1)/(n − 1): 0 when every option is equally likely, 1 when one takes all the mass. Answers
also carry `answer_confidence`, the calibrated probability of the answer given.

Instructions, descriptions and state take text, a JSON object or a JSON array. Give a noul its criteria, or ask a
choice: Kai answers a bare yes/no question less reliably than one whose true and false are described.

## Configuration

| option | environment | default |
|---|---|---|
| `apiKey` | `HANZO_API_KEY` | required |
| `baseURL` | `HANZO_BASE_URL` | `https://api.hanzo.ai` |
| `model` | `KAI_MODEL` | `kai` |
| `logLevel` | `KAI_LOG_LEVEL` | `warn` |
| `timeout` | | 60000 ms per attempt |
| `retry` | | see below |
| `defaultHeaders`, `fetch`, `logger`, `dangerouslyAllowBrowser` | | |

Each call takes `{ signal, timeout, retry, headers }`, overriding the client. The client refuses to run in a browser
page, where the key would be readable, unless `dangerouslyAllowBrowser` is set.

## Errors, retries, timeouts

A status outside 2xx throws its class, carrying the server's sentence as `message` plus `status`, `code`,
`requestId`, `body` and `retryAfter` (seconds):

| status | class |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 402 | `PaymentRequiredError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` |
| 5xx | `InternalServerError` |

No response throws `APIConnectionError`, or `APITimeoutError` past the timeout; an aborted signal throws
`APIUserAbortError`. Every class extends `KaiError`.

Two retries by default, on 408, 409, 429, 5xx, connection errors and timeouts, backing off from 0.5 s doubling to
8 s, less up to 25% at random. `Retry-After` and `retry-after-ms` are honoured up to 60 s. Each retry sends
`X-Kai-Retry-Count`.

```ts
const kai = new Kai({ retry: { maxRetries: 4, httpStatuses: new Set([429, 503]) } });
await kai.decide(request, { timeout: 5_000, retry: { maxRetries: 0 }, signal });
```

## Raw responses and models

```ts
const { data, response, requestId } = await kai.decide(request).withResponse();
const raw = await kai.decide(request).asResponse(); // body unread

const models = await kai.models.list(); // the models that answer decisions: kai, hanzo/kai
```

## License

Apache-2.0
