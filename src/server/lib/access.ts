import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

export interface AccessEnv {
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  ACCESS_EMAIL?: string;
}

export function createAccessVerifier(resolveKey?: JWTVerifyGetKey) {
  let cachedIssuer: string | undefined;
  let cachedKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

  return async (request: Request, env: AccessEnv): Promise<number> => {
    const issuer = env.ACCESS_ISSUER;
    const audience = env.ACCESS_AUD;
    const email = env.ACCESS_EMAIL;
    if (!issuer?.trim() || !audience?.trim() || !email?.trim()) return 503;
    try {
      const url = new URL(issuer);
      if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/.test(issuer) ||
          url.username || url.password || url.port) return 503;
    } catch {
      return 503;
    }

    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return 401;
    try {
      if (!resolveKey && cachedIssuer !== issuer) {
        cachedKeys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
        cachedIssuer = issuer;
      }
      const { payload } = await jwtVerify(token, resolveKey ?? cachedKeys!, {
        algorithms: ["RS256"],
        issuer,
        audience,
        requiredClaims: ["exp", "sub", "email", "type"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim() ||
          payload.type !== "app" || payload.email !== email) return 401;
      return 200;
    } catch {
      return 401;
    }
  };
}
