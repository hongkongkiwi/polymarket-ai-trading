import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { analyzeMarket, gateSignal } from "../src/server/lib/ai";
import type { Signal } from "../src/shared/types";

type Env = Record<string, string | undefined>;

const account = "0123456789abcdef0123456789abcdef";
const gateway = "synthetic-test-gateway";
const directURL = "https://openrouter.ai/api/v1/chat/completions";
const gatewayURL = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/openrouter/chat/completions`;
const question = "Will the synthetic test flag be enabled?";
const signal: Signal = {
  marketId: "synthetic-market",
  question,
  slug: "synthetic-test-flag",
  side: "NO",
  price: 0.25,
  edge: 0.1,
  reason: "Synthetic signal for a unit test.",
  volume: 100,
  quality: {
    total: 80,
    grade: "B",
    liquidity: 20,
    spread: 20,
    activity: 20,
    clarity: 20,
    volume24h: 100,
  },
};

function credentials(): Env {
  return {
    OPENROUTER_API_KEY: randomUUID(),
    CF_AIG_TOKEN: randomUUID(),
  };
}

function gatewayEnv(): Env {
  return {
    ...credentials(),
    AI_GATEWAY_ACCOUNT_ID: account,
    AI_GATEWAY_ID: gateway,
  };
}

function successResponse() {
  const content = {
    take: true,
    recommendation: "YES",
    confidence: 1.2,
    fairValue: 1.2,
    rationale: "Synthetic model response.",
  };
  return Response.json({
    choices: [{ message: { content: `\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\`\n` } }],
  });
}

const callers = [
  {
    name: "analyzeMarket",
    run: (env: Env) => analyzeMarket(env, question, 0.25),
    expected: {
      recommendation: "yes",
      confidence: 1,
      fairValue: 1,
      rationale: "Synthetic model response.",
    },
  },
  {
    name: "gateSignal",
    run: (env: Env) => gateSignal(env, signal),
    expected: { take: true, confidence: 1, rationale: "Synthetic model response." },
  },
];

for (const caller of callers) {
  for (const withGatewayToken of [false, true]) {
    test(`${caller.name}: absent gateway IDs preserve direct routing${withGatewayToken ? " even with a gateway token" : ""}`, async (t) => {
      const env = { ...credentials(), POLYMARKET_MODEL: "synthetic/test-model" };
      if (!withGatewayToken) delete env.CF_AIG_TOKEN;
      const requests: Request[] = [];
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return successResponse();
      });

      assert.deepEqual(await caller.run(env), caller.expected);
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.url, directURL);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("Authorization"), `Bearer ${env.OPENROUTER_API_KEY}`);
      for (const header of ["cf-aig-authorization", "cf-aig-collect-log", "cf-aig-collect-log-payload", "cf-aig-skip-cache"]) {
        assert.equal(request.headers.has(header), false, `${header} must not be sent to OpenRouter directly`);
      }
      assert.equal(request.headers.get("Content-Type"), "application/json");
      assert.equal(request.headers.get("HTTP-Referer"), "https://clawnify.com");
      assert.equal(request.headers.get("X-Title"), "Polymarket AI Trader");
      const body = await request.json();
      assert.equal(body.model, env.POLYMARKET_MODEL);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.temperature, 0.3);
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[1].role, "user");
      assert.ok(body.messages[1].content.includes(question));
    });
  }

  test(`${caller.name}: configured gateway uses separate credentials and disables logging and cache`, async (t) => {
    const env = gatewayEnv();
    const requests: Request[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return successResponse();
    });

    assert.deepEqual(await caller.run(env), caller.expected);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, gatewayURL);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("Authorization"), `Bearer ${env.OPENROUTER_API_KEY}`);
    assert.equal(request.headers.get("cf-aig-authorization"), `Bearer ${env.CF_AIG_TOKEN}`);
    assert.equal(request.headers.get("cf-aig-collect-log"), "false");
    assert.equal(request.headers.get("cf-aig-collect-log-payload"), "false");
    assert.equal(request.headers.get("cf-aig-skip-cache"), "true");
    const body = await request.json();
    assert.equal(body.model, "anthropic/claude-sonnet-4");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.temperature, 0.3);
    assert.ok(body.messages[1].content.includes(question));
    assert.equal(JSON.stringify(body).includes(env.OPENROUTER_API_KEY!), false);
    assert.equal(JSON.stringify(body).includes(env.CF_AIG_TOKEN!), false);
  });

  for (const { name, patch } of [
    { name: "account without gateway", patch: { AI_GATEWAY_ID: undefined } },
    { name: "gateway without account", patch: { AI_GATEWAY_ACCOUNT_ID: undefined } },
    { name: "short account", patch: { AI_GATEWAY_ACCOUNT_ID: account.slice(1) } },
    { name: "non-hex account", patch: { AI_GATEWAY_ACCOUNT_ID: "g".repeat(32) } },
    { name: "uppercase gateway", patch: { AI_GATEWAY_ID: "Synthetic-Gateway" } },
    { name: "gateway path injection", patch: { AI_GATEWAY_ID: "synthetic/other" } },
    { name: "missing gateway token", patch: { CF_AIG_TOKEN: undefined } },
  ] as { name: string; patch: Env }[]) {
    test(`${caller.name}: ${name} rejects before fetch without direct fallback`, async (t) => {
      const fetchMock = t.mock.method(globalThis, "fetch", async () => successResponse());
      await assert.rejects(() => caller.run({ ...gatewayEnv(), ...patch }));
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  }

  for (const useGateway of [false, true]) {
    const mode = useGateway ? "gateway" : "direct";

    test(`${caller.name}: ${mode} requires the provider key before fetch`, async (t) => {
      const env = useGateway ? gatewayEnv() : credentials();
      delete env.OPENROUTER_API_KEY;
      const fetchMock = t.mock.method(globalThis, "fetch", async () => successResponse());
      await assert.rejects(() => caller.run(env));
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    test(`${caller.name}: ${mode} HTTP errors do not expose response body or credentials`, async (t) => {
      const env = useGateway ? gatewayEnv() : credentials();
      const marker = randomUUID();
      const requests: Request[] = [];
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(`${marker} ${env.OPENROUTER_API_KEY} ${env.CF_AIG_TOKEN}`, { status: 429 });
      });

      await assert.rejects(() => caller.run(env), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(marker), false, "HTTP error must not echo the upstream body");
        assert.equal(error.message.includes(env.OPENROUTER_API_KEY!), false, "HTTP error must not expose the provider key");
        assert.equal(error.message.includes(env.CF_AIG_TOKEN!), false, "HTTP error must not expose the gateway token");
        return true;
      });
      assert.deepEqual(requests.map((request) => request.url), [useGateway ? gatewayURL : directURL]);
    });
  }

  test(`${caller.name}: gateway fetch failure never retries directly`, async (t) => {
    const requests: Request[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      throw new Error("Synthetic transport failure.");
    });

    await assert.rejects(() => caller.run(gatewayEnv()));
    assert.deepEqual(requests.map((request) => request.url), [gatewayURL]);
  });
}
