# Paper deployment

Fork: https://github.com/hongkongkiwi/polymarket-ai-trading

Worker: https://pm-ai-trading.savage-apps.workers.dev

Cloudflare account: Savage Apps. Resources use the `pm-` project prefix.

Cloudflare Access protects the Worker's production and preview traffic. The `pm-ai-trading` application allows only `andy+cloudflare@savage.hk`, using Cloudflare account login or an email code. The Worker independently verifies the signed Access JWT, issuer, application audience, expiry, and approved email before serving assets or touching D1. Basic authentication is no longer accepted.

`ACCESS_ISSUER`, `ACCESS_AUD`, and `ACCESS_EMAIL` are non-secret bindings in Wrangler. Missing or invalid configuration fails closed. The short-lived management API token is held outside this repository; it is not a Worker binding. Never commit management tokens or session assertions.

This deployment accepts paper mode only. No relayer credentials or OpenRouter key are configured. There is no cron trigger. Market browsing uses Polymarket's public Gamma API. Paper fills use quoted prices, not an order-book execution model.

AI Gateway transport is documented in [AI_GATEWAY.md](AI_GATEWAY.md). Gateway `pm-openrouter` and its run-only Worker secret are provisioned. Inference remains disabled until provider credentials are supplied. [GAP_ANALYSIS.md](GAP_ANALYSIS.md) records the remaining accounting, simulation and operations gaps.

## Checks and deployment

Run from this repository:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run build
npx wrangler deploy --dry-run
```

No lint command is configured upstream. Before a first deployment, apply `src/server/schema.sql`, then tracked D1 migrations. For an existing ledger, follow [LEDGER_MIGRATION.md](LEDGER_MIGRATION.md); code and accounting triggers must be upgraded together under maintenance. Do not reinitialize or reset an existing ledger without checking its contents.

```sh
npx wrangler d1 execute pm-ai-trading-db --remote --file src/server/schema.sql
npx wrangler d1 migrations apply pm-ai-trading-db --remote
npx wrangler deploy
```

The `dev` script initializes the project database and applies local migrations before starting Vite and Wrangler. Production uses a native request-bound D1 binding; the Clawnify preview storage adapter is no longer used. Local requests also require a valid Access assertion for the configured application. There is no local Basic-auth bypass. Authentication tests generate temporary signing keys and never use a production session.

## Verification on 2026-11-15

- TypeScript and Vite production build passed.
- 17 independent deployment-boundary tests and 5 hardening regression tests passed.
- Security review identified an encoded-path settings bypass and dropped asset-response headers. Both were fixed and the scoped review confirmed the fixes.
- Deployed health and settings returned HTTP 200 with paper mode and AI disabled.
- Deployed market listing returned real Gamma data.
- Unauthenticated health returned HTTP 401 with a Basic challenge.
- Encoded-path live-mode write returned HTTP 400; unknown API route returned JSON HTTP 404.
- Python urllib requests were blocked by Cloudflare with error 1010. Curl reached the application successfully.

Browser interaction and full trading-cycle behavior were not verified during the initial deployment. The tests use mocked D1 and assets; deployed smoke checks supplement them but do not establish strategy correctness.

## Access migration on 2026-11-16

The live API confirmed application `ae5e3921-5786-4004-8ddb-83b0da91539d`, audience matching Wrangler, Worker destination `3daa74cd3da04329bcf397aec4e8ceaf`, and one exact-email allow policy. The team is `quiet-heart-ed97`. The management token expires on 2026-11-23 and is not required for runtime login.

All 64 tests, TypeScript, production build, and Worker dry run passed. Security review found no source defects; live API checks confirmed issuer and audience. Deployment version: `58e6d1ca-16c0-44a9-810b-de7fd0c3498f`. Unauthenticated requests redirect to Cloudflare Access. The API confirms preview URLs are disabled.

The Edge browser reached the login page with Cloudflare and email-code choices, but subsequent browser actions timed out. A complete authenticated browser session has not been verified. No MFA or login code was bypassed.
