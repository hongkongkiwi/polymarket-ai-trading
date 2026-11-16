import assert from "node:assert/strict";
import test, { after } from "node:test";
import app from "../src/server/index";
import { accessEnv, assertion, mockAccessFetch } from "./access-fixture";

after(mockAccessFetch());

const env = {
  ...accessEnv,
  DB: { prepare() { throw new Error("Unexpected database access"); } },
  ASSETS: { async fetch() { return new Response("dashboard"); } },
};

for (const path of ["/api/%73ettings", "/api/s%65ttings", "/%61pi/settings"]) {
  test(`encoded live-mode write rejected: ${path}`, async () => {
    const response = await app.request(path, {
      method: "PUT",
      headers: { "Cf-Access-Jwt-Assertion": assertion, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "live" }),
    }, env);
    assert.equal(response.status, 400);
  });
}

test("dashboard responses carry anti-framing and private cache headers", async () => {
  const response = await app.request("/", { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("cross-origin authenticated writes are rejected before database access", async () => {
  const response = await app.request("/api/reset", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": assertion, Origin: "https://other.example" },
  }, env);
  assert.equal(response.status, 403);
});
