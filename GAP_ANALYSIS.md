# Platform gap analysis

Assessment date: 2026-11-16. Base revision: `4c2d0e4`. Fork: https://github.com/hongkongkiwi/polymarket-ai-trading.

This is a source-based assessment, not a trading audit or an executed reproduction of accounting failures. Access and deployment tests do not prove ledger correctness. Scope is paper trading on Cloudflare Workers; real-money execution is deliberately excluded.

## Current baseline

The fork has a React dashboard, Hono API, D1 position ledger, Gamma market browsing, threshold signals, fractional-Kelly sizing, manual cycles, marking/closing, and portfolio totals. Cloudflare Access checks signed identity before API or asset access. Non-paper mode updates are rejected and the live executor refuses orders.

The highest-priority gaps concern the reliability of paper results. Add provider routing independently, but do not enable unattended scans before repairing accounting and settlement.

P0 means a blocker to trusting paper results or enabling automation. It does not mean demonstrated real-money exposure. Paths and line numbers below refer to the base revision.

## Correctness and safety

### F1. P0: ledger changes are neither atomic nor idempotent

`src/server/lib/engine.ts:31-117` reads cash and open positions, inserts trades individually, then overwrites cash. Overlapping cycles can spend the same balance or exceed portfolio caps. Failure after insertion but before the cash update leaves an uncharged position. Close and settlement update a trade and credit cash separately without an open-status condition (`engine.ts:161-170,194-212`). Reset also spans separate writes (`engine.ts:218-220`). These are demonstrated source paths, not executed race reproductions.

Acceptance: one atomic mutation protocol for opens, closes, settlement, reset, and capital adjustments. Concurrent cycles respect cash/exposure/position limits. Duplicate close or settlement credits once. Failure injection leaves no partial accounting. Use D1 transactional batches with conditional writes or a serialized Durable Object; do not use a KV pseudo-lock. Choose the transaction design before writing migrations.

### F2. P0: market closure is treated as resolution

`engine.ts:161-170` settles when `closed` is true or a price is near zero/one. Neither condition alone proves a resolved outcome. A closed market with an intermediate quote can pay at that quote; an active extreme-priced market can become realized P&L prematurely.

Acceptance: separate marks, manual exits, and verified resolution payouts. Closed-but-unresolved markets remain unsettled. Persist outcome identity, resolution evidence, timestamp, and close reason. Settlement must be replay-safe. Depends on F1 and F5.

### F3. P1: settings and safety semantics need runtime validation

`src/server/index.ts:71-103` checks settings object shape and paper mode, but `src/server/lib/store.ts:46-93` writes other known fields without type/range or cross-field checks. Invalid position limits and string switches can persist. The kill switch is checked only before network work (`engine.ts:31-47`), so an in-flight cycle can continue opening. Required AI gating silently becomes inactive without a provider key (`engine.ts:47`).

Acceptance: invalid values return 400 without writes; threshold relationships are enforced; kill switch is checked at atomic opening; unavailable required gating blocks new positions. AI Gateway routing alone does not repair this pre-existing gate behavior.

### F4. P1: exits use stale prices and fills omit execution costs

A new position receives `current_price`; `closeTrade` fetches only when it is null (`engine.ts:93-104,194-205`). Most closes use the entry price or last manual mark, regardless of age, and bypass `Executor.sell`. `src/server/lib/executor.ts:34-44` buys immediately at the quoted price with no depth, partial fills, spread, fees, or slippage.

Acceptance: executable-side snapshots have timestamps and source identity. Stale or missing books block simulated execution. Store the fill model version, book evidence, fees, slippage, and partial-fill policy. Existing quote fills retain their original model designation. Depends on F1/F5.

### F5. P1: market normalization trusts ordering and weak data

`src/server/lib/gamma.ts:9-79` assigns YES/NO by array position without validating labels, supported binary shape, or token mapping. Finite prices outside [0,1] can survive parsing; absent IDs can become empty strings. Successful non-array responses become empty scans, and individual lookup failures resemble missing markets. Engine callers provide no deadline.

Acceptance: validate IDs, binary outcome/token mapping, bounded prices, and timestamps. Quarantine unsupported records. Distinguish malformed data, absence, throttling, and outages. Use deadlines and bounded retries before F2/F4 consume data.

### F6. P1: edge and quality scores are heuristics, not recorded forecasts

`src/server/lib/signals.ts:22-73` assigns fixed edge values. `src/server/lib/kelly.ts:19-32` converts them into assumed probabilities. Quality ranks rather than excludes poor grades. `src/server/lib/quality.ts:18-40` uses lifetime volume for liquidity scoring and gives missing spread maximum spread points.

Acceptance: label heuristics explicitly; missing inputs remain unknown; define eligibility checks; persist forecast provenance and strategy/configuration versions before reporting expected value or calibration. Do not claim profitable signals from these scores.

### F7. P1: trading correctness lacks executable coverage

Existing suites exercise authentication, routes, headers, and paper-mode rejection. D1 fixtures return canned results (`tests/deployment.test.ts:8-23`); no accounting, settlement, market-normalization, or sizing suite exercises actual SQL. `tests/run.mjs:17-31` runs one selected suite and `package.json:6-10` has no all-tests or lint gate.

Acceptance: independently authored tests precede ledger changes, execute SQL-compatible storage, and cover overlapping operations and injected failures. One documented command must run every suite. Keep authentication coverage intact.

## Product and operations

### F8. P2: performance lacks attributable history

`src/server/schema.sql:2-40` holds mutable positions/settings, not a cash-flow journal, immutable snapshots, versioned forecasts, or equity history. Editing cash changes performance without a capital-adjustment record. `store.ts:117-145` loads every trade for totals and returns a bounded latest history without cursor pagination. The dashboard calls manually closed positions settled (`src/client/app.tsx:169-174`).

Acceptance: attributed capital adjustments, cost-aware P&L, SQL aggregates, paginated/exportable history, equity/drawdown history, and distinct close/settlement metrics. Calibration requires recorded predictions paired with verified outcomes, not fabricated seed history.

### F9. P2: scanner operations and UI do not expose failure states

`src/client/app.tsx:41-80` hides cycle notes and converts a signal-fetch failure to empty results. `src/client/components/tables.tsx:40-41` describes no signals as fairly priced. There is no durable run history, data-freshness UI, watchlist/filter workflow, or bounded scheduled scanner. Marking performs sequential fallback lookups (`engine.ts:145-154`). Local dev names the upstream rather than configured database.

Acceptance: distinguish empty/error/stale states; expose skip reasons and last successful runs; bound market fetches and per-tick work; reconcile local setup. Scheduling follows tested overlap/retry controls, not the reverse.

### F10. P1: AI transport and spend controls are incomplete

`src/server/lib/ai.ts:28-66` calls OpenRouter directly, lacks a request deadline, echoes upstream error bodies, and does not enforce an output-token or application spend budget. Responses are loosely coerced; for example `Boolean(j.take)` treats a nonempty string as true (`ai.ts:86`). There is no prompt/model/usage provenance or calibrated evidence.

First increment: optional AI Gateway routing, strict route configuration, separate gateway/provider secrets, no fallback after gateway failure, no prompt logging/caching, and sanitized errors. This does not make inference free or validate AI forecasts. Later increments: strict result schema, deadline, output bounds, per-run/daily budget reservation, and versioned analysis records. Gateway rate limits alone are not a dollar cap.

## Edge Scanner comparison

Reference pinned to `ae52930bf0082c713f080d573a9c349bcf8f3924`: https://github.com/tonystechofficial/polymarket-edge-scanner/tree/ae52930bf0082c713f080d573a9c349bcf8f3924. Selected source was inspected; this was not a full audit of that project.

| Reference module | Useful capability | Adoption condition |
| --- | --- | --- |
| `packages/strategy/src/simulator.ts` | Walks book depth, computes VWAP, fees, slippage and partial fills; records assumptions; separate payout calculation | Validate current market fee rules and units. Port only after F1/F5. Its model explicitly omits latency, queue position and adverse selection. |
| `packages/strategy/src/calibration.ts` | Minimum samples, price/horizon buckets, Wilson intervals, Brier score, log loss and reliability bins | Build verified outcome history first. Check baseline comparisons use the same eligible samples before presenting relative performance. |
| `packages/strategy/src/decide.ts` | Requires independent estimates and checks conservative probability bounds against execution costs and risk limits | Replace heuristic edge semantics explicitly; persist rejection reasons and estimate provenance. |
| `apps/worker/src/scan/run.ts` | Bounded discovery/pricing/resolution phases, cursor progression, budget checks and analysis history | Review overlap/transaction behavior independently. Its closed-plus-extreme-price resolution heuristic is not sufficient evidence for our F2 acceptance. |
| `packages/ai/src/budget.ts` | Per-invocation call/neuron checks | Not a shared atomic daily reservation. Do not copy it as a guaranteed cross-request budget. |

Retain MIT attribution for copied code. Verify dependencies and interfaces before choosing modules. No Edge Scanner code is incorporated by this analysis.

## Recommended implementation order

A1. AI Gateway transport as an isolated first feature. Keep inference disabled until provider credentials are explicitly configured; do not enable a scheduler.

A2. Ledger integrity, settings validation and SQL-backed regression tests (F1/F3/F7). This is the prerequisite for trustworthy results.

A3. Validated market evidence and verified settlement (F5/F2), with reviewed history-preserving migrations.

A4. Versioned execution simulation (F4), then forecast quality and evidence gates (F6).

A5. Durable runs, user-visible error/freshness states, performance history and pagination (F8/F9). Only then add unattended scanning.

## Coverage limits

Accounting failures above are source traces and require executed failing-first reproductions before repair. No real trades or paid inference were performed. A complete authenticated browser session was not reverified for this analysis. Provider data contracts and current fee schedules need first-party verification at implementation time. The base project's licensing permission was confirmed by the user; this assessment does not add an upstream license.
