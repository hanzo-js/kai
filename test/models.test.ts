import assert from "node:assert/strict";
import { test } from "node:test";
import { Kai } from "@hanzo/kai";
import { json, MODELS, scripted } from "./fetch.ts";

test("models.list keeps the models whose outputs include decision", async () => {
  const { fetch } = scripted(() => json(MODELS, 200, { "x-request-id": "9add3e1e" }));
  const kai = new Kai({ apiKey: "sk-test", fetch });
  const models = await kai.models.list();
  assert.deepEqual(
    models.map((m) => m.id),
    ["hanzo/kai", "kai"],
  );
  const [first] = models;
  assert.equal(first?.owned_by, "hanzo");
  assert.equal(first?.created, 1790629541);
  assert.deepEqual(first?.pricing, { prompt: "0.000000021", completion: "0", input_per_million: 0.021, output_per_million: 0 });
  const { data, requestId, response } = await kai.models.list().withResponse();
  assert.equal(data.length, 2);
  assert.equal(requestId, "9add3e1e");
  assert.equal(response.status, 200);
});

test("models.list refuses a body without a data list", async () => {
  for (const body of [{ models: [] }, { data: null }, [], "text"]) {
    const { fetch } = scripted(() => json(body));
    await assert.rejects(new Kai({ apiKey: "sk-test", fetch }).models.list(), {
      name: "KaiError",
      message: "GET /v1/models answered without a 'data' list",
    });
  }
});
