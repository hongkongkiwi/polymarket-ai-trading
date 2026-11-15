# Paper deployment

Fork: https://github.com/hongkongkiwi/polymarket-ai-trading

Worker: https://pm-ai-trading.savage-apps.workers.dev

Cloudflare account: Savage Apps. Resources use the `pm-` project prefix.

The Worker serves the dashboard assets and API behind HTTP Basic authentication. Configure `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` as Worker secrets. Missing credentials fail closed. Do not put passwords in source or Wrangler vars.

This deployment accepts paper mode only. No relayer credentials or OpenRouter key are configured. There is no cron trigger. Market browsing uses Polymarket's public Gamma API. Paper fills use quoted prices, not an order-book execution model.

## Checks and deployment

Run from this repository:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
node tests/run.mjs
node tests/run.mjs ./hardening.test.ts
pnpm run build
npx wrangler deploy --dry-run
```

No lint command is configured upstream. Before a first deployment, apply `src/server/schema.sql` to the dedicated D1 database. The current database is already initialized. Do not reinitialize or reset an existing ledger without checking its contents.

```sh
npx wrangler d1 execute pm-ai-trading-db --remote --file src/server/schema.sql
npx wrangler deploy
```

The upstream `dev` script still names the upstream database. For this fork, initialize local storage with `wrangler d1 execute pm-ai-trading-db --local --file src/server/schema.sql`, build assets, and use `wrangler dev`. Local authentication also needs both dashboard secrets in a gitignored `.dev.vars` file.

## Verification on 2026-11-15

- TypeScript and Vite production build passed.
- 17 independent deployment-boundary tests and 5 hardening regression tests passed.
- Security review identified an encoded-path settings bypass and dropped asset-response headers. Both were fixed and the scoped review confirmed the fixes.
- Deployed health and settings returned HTTP 200 with paper mode and AI disabled.
- Deployed market listing returned real Gamma data.
- Unauthenticated health returned HTTP 401 with a Basic challenge.
- Encoded-path live-mode write returned HTTP 400; unknown API route returned JSON HTTP 404.
- Python urllib requests were blocked by Cloudflare with error 1010. Curl reached the application successfully.

Browser interaction and full trading-cycle behavior have not been verified. The tests use mocked D1 and assets; deployed smoke checks supplement them but do not establish strategy correctness.
