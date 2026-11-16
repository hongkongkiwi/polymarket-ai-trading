import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const accessEnv = {
  ACCESS_ISSUER: "https://test-team.cloudflareaccess.com",
  ACCESS_AUD: "test audience",
  ACCESS_EMAIL: "test@example.com",
};

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
export const assertion = await new SignJWT({ type: "app", email: accessEnv.ACCESS_EMAIL })
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
  .setSubject("test-subject")
  .setIssuer(accessEnv.ACCESS_ISSUER)
  .setAudience(accessEnv.ACCESS_AUD)
  .setExpirationTime("5m")
  .sign(privateKey);

export function mockAccessFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${accessEnv.ACCESS_ISSUER}/cdn-cgi/access/certs`) throw new Error(`Unexpected fetch: ${url}`);
    return Response.json({ keys: [jwk] });
  };
  return () => { globalThis.fetch = original; };
}
