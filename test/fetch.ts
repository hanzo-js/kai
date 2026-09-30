import type { Fetch, Logger } from "@hanzo/kai";

/** One request as the scripted fetch saw it. */
export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}

/**
 * A fetch that answers the nth call with `answer(call, n)` and records every call.
 * Like a real fetch, it rejects with the signal's reason once the signal aborts.
 */
export function scripted(answer: (call: Call, n: number) => Response | Promise<Response>): {
  fetch: Fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    const n = calls.push(call) - 1;
    const signal = init?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve()
        .then(() => answer(call, n))
        .then(resolve, reject);
    });
  };
  return { fetch, calls };
}

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A response that never arrives; only an abort ends it. */
export function hang(): Promise<Response> {
  return new Promise(() => {});
}

/** A logger that keeps every call as [level, message, ...args]. */
export function recorder(): Logger & { lines: [string, string, ...unknown[]][] } {
  const lines: [string, string, ...unknown[]][] = [];
  const at =
    (level: string) =>
    (message: string, ...args: unknown[]): void => {
      lines.push([level, message, ...args]);
    };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** Messages logged at `level`. */
export function said(log: ReturnType<typeof recorder>, level: string): string[] {
  return log.lines.filter((l) => l[0] === level).map((l) => l[1]);
}

/** Lets every pending callback and promise chain run; timers stay where they are. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A decision body in the shape POST /v1/decisions answers. */
export const DECISION = {
  id: "dec_0123456789abcdef0123456789abcdef",
  model: "kai",
  provider: "Hanzo",
  answers: {
    team: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.9333, tech: 0.0667 },
      answer_confidence: 0.9333,
    },
    refund: { type: "noul", noul: 0.81, answer_confidence: 0.81 },
    urgency: {
      type: "score",
      score: 1.25,
      confidence: 0.3,
      legend: { "0": "can wait", "1": "this week", "2": "today" },
      probabilities: { "0": 0.2, "1": 0.35, "2": 0.45 },
      answer_confidence: 0.45,
    },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
  routing: {
    backend: "kai",
    checkpoint: "a7",
    sha256: "0834a74f2d140642a453373da09e5a128e3d2c8d9e8bb1dcaf86d7210a4ecdfc",
    calibration: "cal_e23c27a1f768bff7",
    device: "cpu",
    reason: "explicit model='kai'",
  },
  state_hash: "sha256:df57ac6b3f6d3c309e3dd1f9922f95324c3eca0c205d3888f8dd4ad3339ca019",
  latency_ms: 212.06,
};

/** The first entries of GET /v1/models, which lists every model the gateway serves. */
export const MODELS = {
  object: "list",
  data: [
    {
      id: "aion-labs/aion-2.0",
      object: "model",
      created: 1790629541,
      owned_by: "aion-labs",
      premium: true,
      context_window: 131072,
      outputs: ["text"],
      pricing: { prompt: "0.00000096", completion: "0.00000192", input_per_million: 0.96, output_per_million: 1.92 },
    },
    {
      id: "hanzo/kai",
      object: "model",
      created: 1790629541,
      owned_by: "hanzo",
      premium: false,
      outputs: ["decision"],
      pricing: { prompt: "0.000000021", completion: "0", input_per_million: 0.021, output_per_million: 0 },
    },
    { id: "legacy/none", object: "model", created: 1790629541, owned_by: "legacy", outputs: null },
    {
      id: "kai",
      object: "model",
      created: 1790629541,
      owned_by: "hanzo",
      premium: false,
      outputs: ["decision"],
      pricing: { prompt: "0.000000021", completion: "0", input_per_million: 0.021, output_per_million: 0 },
    },
  ],
};
