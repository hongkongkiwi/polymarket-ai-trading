import assert from "node:assert/strict";
import test from "node:test";
import app from "../src/server/index";

const credentials = {
  DASHBOARD_USERNAME: "deployment-test-user",
  DASHBOARD_PASSWORD: "deployment-test-password",
};
const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const authorization = basic(credentials.DASHBOARD_USERNAME, credentials.DASHBOARD_PASSWORD);

function bindings({ rejectDB = false } = {}) {
  const calls = { db: 0, assets: [] as Request[] };
  const statement = {
    bind() { return this; },
    async run() { return { success: true, meta: {} }; },
    async first() { return null; },
    async all() { return { results: [] }; },
  };
  const env = {
    ...credentials,
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
  { name: "both credentials", path: "/", missing: ["DASHBOARD_USERNAME", "DASHBOARD_PASSWORD"] },
  { name: "username", path: "/assets/dashboard.js", missing: ["DASHBOARD_USERNAME"] },
  { name: "password", path: "/api/settings", missing: ["DASHBOARD_PASSWORD"] },
]) {
  test(`missing configured ${name} returns 503 before DB or assets`, async () => {
    const { env, calls } = bindings({ rejectDB: true });
    for (const key of missing) delete env[key as keyof typeof credentials];
    const response = await app.request(path, { headers: { Authorization: authorization } }, env);
    assert.equal(response.status, 503);
    assert.equal(calls.db, 0);
    assert.equal(calls.assets.length, 0);
  });
}

for (const { name, path, header } of [
  { name: "dashboard without credentials", path: "/" },
  { name: "asset without credentials", path: "/assets/dashboard.js" },
  { name: "API root without credentials", path: "/api" },
  { name: "API settings without credentials", path: "/api/settings" },
  { name: "unknown API without credentials", path: "/api/does-not-exist" },
  { name: "wrong username", path: "/api/settings", header: basic("wrong-user", credentials.DASHBOARD_PASSWORD) },
  { name: "wrong password", path: "/assets/dashboard.js", header: basic(credentials.DASHBOARD_USERNAME, "wrong-password") },
  { name: "non-Basic authorization", path: "/", header: "Bearer not-basic" },
]) {
  test(`${name} returns 401 with Basic challenge before DB or assets`, async () => {
    const { env, calls } = bindings({ rejectDB: true });
    const response = await app.request(path, {
      headers: header ? { Authorization: header } : {},
    }, env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("WWW-Authenticate") ?? "", /^Basic\b/i);
    assert.equal(calls.db, 0);
    assert.equal(calls.assets.length, 0);
  });
}

for (const path of ["/", "/assets/dashboard.js?version=1"]) {
  test(`valid credentials serve ${path} through ASSETS`, async () => {
    const { env, calls } = bindings();
    const response = await app.request(path, { headers: { Authorization: authorization } }, env);
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
    const response = await app.request(path, { headers: { Authorization: authorization } }, env);
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
    headers: { Authorization: authorization, "Content-Type": "application/json" },
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
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "paper" }),
  }, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, "paper");
  assert.equal(calls.assets.length, 0);
});
