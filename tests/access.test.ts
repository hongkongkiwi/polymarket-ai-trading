import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, SignJWT, type JWTPayload } from "jose";
import { createAccessVerifier } from "../src/server/lib/access";

const env = {
  ACCESS_ISSUER: "https://test-team.cloudflareaccess.com",
  ACCESS_AUD: "test-application",
  ACCESS_EMAIL: "test@example.com",
};
const trusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
const untrusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
const resolveKey = createLocalJWKSet({ keys: [{
  ...trusted.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
}] });
const verify = createAccessVerifier(resolveKey);

function claims(): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: env.ACCESS_ISSUER,
    aud: env.ACCESS_AUD,
    email: env.ACCESS_EMAIL,
    sub: "test-subject",
    type: "app",
    exp: now + 3600,
  };
}

function sign(payload = claims(), key = trusted.privateKey) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key);
}

function request(token?: string, headers: Record<string, string> = {}) {
  return new Request("https://dashboard.example.com/", {
    headers: {
      ...headers,
      ...(token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token }),
    },
  });
}

test("valid signed Access app token returns 200 without an email header", async () => {
  assert.equal(await verify(request(await sign()), env), 200);
});

test("signed identity is authoritative over the unsigned email header", async () => {
  assert.equal(await verify(request(await sign(), {
    "Cf-Access-Authenticated-User-Email": "Test@example.com",
  }), env), 200);
});

test("issuer configuration accepts an optional trailing slash with exact signed issuer", async () => {
  const issuer = `${env.ACCESS_ISSUER}/`;
  const token = await sign({ ...claims(), iss: issuer });
  assert.equal(await verify(request(token), { ...env, ACCESS_ISSUER: issuer }), 200);
});

test("not-before allows an already active signed token", async () => {
  const token = await sign({ ...claims(), nbf: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(await verify(request(token), env), 200);
});

for (const { name, patch, omit } of [
  { name: "wrong issuer", patch: { iss: "https://other-team.cloudflareaccess.com" } },
  { name: "issuer prefix match", patch: { iss: `${env.ACCESS_ISSUER}/extra` } },
  { name: "wrong audience", patch: { aud: "other-application" } },
  { name: "audience prefix match", patch: { aud: `${env.ACCESS_AUD}-extra` } },
  { name: "wrong signed email despite approved email header", patch: { email: "Test@example.com" } },
  { name: "expired token", patch: { exp: Math.floor(Date.now() / 1000) - 3600 } },
  { name: "future not-before", patch: { nbf: Math.floor(Date.now() / 1000) + 3600 } },
  { name: "missing expiration", omit: "exp" },
  { name: "missing subject", omit: "sub" },
  { name: "empty subject", patch: { sub: "" } },
  { name: "missing app type", omit: "type" },
  { name: "wrong app type", patch: { type: "service" } },
  { name: "missing signed email", omit: "email" },
] as { name: string; patch?: JWTPayload; omit?: string }[]) {
  test(`${name} returns 401`, async () => {
    const payload = { ...claims(), ...patch };
    if (omit) delete payload[omit];
    const token = await sign(payload);
    assert.equal(await verify(request(token, {
      "Cf-Access-Authenticated-User-Email": env.ACCESS_EMAIL,
    }), env), 401);
  });
}

test("token signed by an untrusted RSA key returns 401", async () => {
  assert.equal(await verify(request(await sign(claims(), untrusted.privateKey)), env), 401);
});

test("unsigned token and token with its signature removed return 401", async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "none" })}.${encode(claims())}.`;
  const signed = await sign();
  const withoutSignature = `${signed.split(".").slice(0, 2).join(".")}.`;
  for (const token of [unsigned, withoutSignature]) {
    assert.equal(await verify(request(token), env), 401);
  }
});

test("HS256 token cannot replace the required RS256 signature", async () => {
  const token = await new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", kid: "test-key" })
    .sign(randomBytes(32));
  assert.equal(await verify(request(token), env), 401);
});

test("malformed and empty assertions return 401 without throwing", async () => {
  for (const token of ["", "not-a-jwt", "a.b.c", "e30.e30.invalid"])
    assert.equal(await verify(request(token), env), 401, JSON.stringify(token));
});

test("missing assertion cannot fall back to Basic, Bearer, or unsigned identity headers", async () => {
  const username = randomUUID();
  const password = randomUUID();
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const configured = { ...env, DASHBOARD_USERNAME: username, DASHBOARD_PASSWORD: password };
  for (const headers of [
    {},
    { "Cf-Access-Authenticated-User-Email": env.ACCESS_EMAIL },
    { Authorization: basic, "Cf-Access-Authenticated-User-Email": env.ACCESS_EMAIL },
    { Authorization: `Bearer ${await sign()}` },
  ]) {
    assert.equal(await verify(request(undefined, headers), configured), 401);
  }
});

for (const key of ["ACCESS_ISSUER", "ACCESS_AUD", "ACCESS_EMAIL"] as const) {
  for (const value of [undefined, "", "   "]) {
    test(`${key} ${value === undefined ? "missing" : JSON.stringify(value)} returns 503`, async () => {
      assert.equal(await verify(request(await sign()), { ...env, [key]: value }), 503);
    });
  }
}

for (const issuer of [
  "not-a-url",
  "http://test-team.cloudflareaccess.com",
  "https://cloudflareaccess.com",
  "https://test-team.cloudflareaccess.com.example.com",
  "https://notcloudflareaccess.com",
  `${env.ACCESS_ISSUER}/path`,
  `${env.ACCESS_ISSUER}?query=1`,
  `${env.ACCESS_ISSUER}#fragment`,
  "https://user@test-team.cloudflareaccess.com",
  "https://test-team.cloudflareaccess.com:8443",
]) {
  test(`invalid issuer configuration ${issuer} returns 503`, async () => {
    const token = await sign({ ...claims(), iss: issuer });
    assert.equal(await verify(request(token), { ...env, ACCESS_ISSUER: issuer }), 503);
  });
}
