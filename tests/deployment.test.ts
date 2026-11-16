import assert from "node:assert/strict";
import test, { after } from "node:test";
import app from "../src/server/index";
import { accessEnv, assertion, mockAccessFetch } from "./access-fixture";

after(mockAccessFetch());

function bindings({ rejectDB = false } = {}) {
  const calls = { db: 0, assets: [] as Request[] };
  const statement = {
    bind() { return this; },
    async run() { return { success: true, meta: { changes: 1 } }; },
    async first() { return {
      mode: "paper", paper_epoch: 0, revision: 1, bankroll: 1000, kelly_fraction: 0.25,
      max_positions: 10, max_position_usd: 100, max_exposure_usd: 600, min_volume_usd: 10000,
      favorite_threshold: 0.75, longshot_min: 0.05, longshot_max: 0.2, ai_gating: 1, kill_switch: 0,
    }; },
    async all() { return { results: [] }; },
  };
  const env = {
    ...accessEnv,
    DB: {
      prepare() {
        calls.db++;
        if (rejectDB) throw new Error("Unexpected DB access in rejected request");
        return statement;
      },
    },
    ASSETS: {
      async fetch(request: Request) {
        calls.assets.push(request);
        return new Response("dashboard asset fixture", {
          headers: { "Content-Type": "text/javascript", "X-Asset-Fixture": "served" },
        });
      },
    },
  };
  return { env, calls };
}

for (const { name, path, missing } of [
  { name: "all Access configuration", path: "/", missing: ["ACCESS_ISSUER", "ACCESS_AUD", "ACCESS_EMAIL"] },
  { name: "issuer", path: "/assets/dashboard.js", missing: ["ACCESS_ISSUER"] },
  { name: "audience", path: "/api/settings", missing: ["ACCESS_AUD"] },
  { name: "email", path: "/api/settings", missing: ["ACCESS_EMAIL"] },
]) {
  test(`missing configured ${name} returns 503 before DB or assets`, async () => {
    const { env, calls } = bindings({ rejectDB: true });
    for (const key of missing) delete env[key as keyof typeof accessEnv];
    const response = await app.request(path, { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env);
    assert.equal(response.status, 503);
    assert.equal(calls.db, 0);
    assert.equal(calls.assets.length, 0);
  });
}

for (const { name, path, headers } of [
  { name: "dashboard without assertion", path: "/" },
  { name: "asset without assertion", path: "/assets/dashboard.js" },
  { name: "API root without assertion", path: "/api" },
  { name: "API settings without assertion", path: "/api/settings" },
  { name: "unknown API without assertion", path: "/api/does-not-exist" },
  { name: "invalid assertion", path: "/api/settings", headers: { "Cf-Access-Jwt-Assertion": "invalid" } },
  { name: "forged email header", path: "/assets/dashboard.js", headers: { "Cf-Access-Authenticated-User-Email": accessEnv.ACCESS_EMAIL } },
  { name: "Basic authorization", path: "/", headers: { Authorization: `Basic ${Buffer.from(crypto.randomUUID()).toString("base64")}` } },
]) {
  test(`${name} returns 401 without challenge before DB or assets`, async () => {
    const { env, calls } = bindings({ rejectDB: true });
    const response = await app.request(path, { headers }, env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), null);
    assert.equal(calls.db, 0);
    assert.equal(calls.assets.length, 0);
  });
}

for (const path of ["/", "/assets/dashboard.js?version=1"]) {
  test(`valid credentials serve ${path} through ASSETS`, async () => {
    const { env, calls } = bindings();
    const response = await app.request(path, { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "dashboard asset fixture");
    assert.equal(response.headers.get("X-Asset-Fixture"), "served");
    assert.equal(calls.assets.length, 1);
    assert.equal(new URL(calls.assets[0].url).pathname + new URL(calls.assets[0].url).search, path);
  });
}

for (const path of ["/api", "/api/does-not-exist"]) {
  test(`authenticated unknown route ${path} returns JSON 404 instead of SPA`, async () => {
    const { env, calls } = bindings();
    const response = await app.request(path, { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("Content-Type") ?? "", /^application\/json\b/i);
    const body = await response.json();
    assert.equal(typeof body, "object");
    assert.notEqual(body, null);
    assert.equal(calls.assets.length, 0);
  });
}

test("authenticated live mode is rejected before DB access", async () => {
  const { env, calls } = bindings({ rejectDB: true });
  const response = await app.request("/api/settings", {
    method: "PUT",
    headers: { "Cf-Access-Jwt-Assertion": assertion, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "live" }),
  }, env);
  assert.equal(response.status, 400);
  assert.equal(calls.db, 0);
  assert.equal(calls.assets.length, 0);
});

test("authenticated paper mode remains editable", async () => {
  const { env, calls } = bindings();
  const response = await app.request("/api/settings", {
    method: "PUT",
    headers: { "Cf-Access-Jwt-Assertion": assertion, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "paper", revision: 0, paperEpoch: 0 }),
  }, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "paper");
  assert.equal(calls.assets.length, 0);
});
