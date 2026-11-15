# Edge Scanner integration direction

Reference project: https://github.com/tonystechofficial/polymarket-edge-scanner

Keep this application's React dashboard, Hono routes, and D1 ledger as the base. Port features individually rather than merging both applications. No Edge Scanner code has been incorporated yet.

## Proposed sequence

1. Execution simulation: replace immediate quote-price fills with a versioned simulation model using order-book depth, spread, fees, and slippage. Preserve the market snapshot and model assumptions alongside each fill. Reject stale or missing books instead of presenting them as executable prices.
2. Settlement: distinguish discretionary closes from resolved-market payouts. Store outcome identifiers and settlement evidence. Make settlement idempotent so repeated scans cannot credit a position twice.
3. Performance reporting: separate realized and unrealized P&L, include execution costs, and report calibration only when recorded forecasts and resolved outcomes exist. Do not imply paper results predict live returns.
4. Scheduled scanning: add a bounded cron pipeline after manual cycles are covered by tests. Prevent overlapping cycles from exceeding portfolio limits; use atomic database operations or a Durable Object, not a KV pseudo-lock.

## Acceptance conditions before each feature ships

- Independently authored tests cover the new ledger or execution behavior before implementation.
- Schema changes preserve existing paper history and have a reviewed migration procedure.
- Paper-only enforcement remains at the server boundary. No wallet signing or live order submission is added.
- Retain Edge Scanner's MIT attribution for any copied code. The user confirmed permission to adopt and modify the base project on 2026-11-15; this fork does not assert a new upstream license.

The sequence is an integration proposal, not a source-level compatibility assessment. Inspect the current Edge Scanner implementation and its exact dependencies before choosing copied modules or designing migrations.
