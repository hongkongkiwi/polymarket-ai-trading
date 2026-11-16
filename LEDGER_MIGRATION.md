# Paper ledger integrity migration

The baseline schema remains `src/server/schema.sql`. Upgrade existing databases with tracked D1 migrations; replaying `CREATE TABLE IF NOT EXISTS` does not add columns or triggers.

## Accounting protocol

Each accepted open is one conditional insert. A SQLite trigger debits cash in that statement's transaction. Each close is one open-to-closed transition; its trigger credits proceeds once. Both operations increment the settings revision. The database checks current cash, position/exposure caps, paper mode, kill switch and session epoch when accepting an open. Repeating an operation key with the same immutable fill returns the original ID; conflicting reuse is rejected.

Reset advances `paper_epoch` rather than deleting trades. Old-session rows remain unchanged and cannot be marked or closed by current-session requests. Current portfolio totals scope to the active epoch. This is an accounting session reset, not a simulated sale or a payout. Stale settings updates must match both revision and epoch.

This migration does not repair historical accounting or change the existing price/settlement evidence heuristics. Those remain separate gaps in `GAP_ANALYSIS.md`.

## Upgrade procedure

1. Inspect current settings, open rows, and monetary invariants. Stop if active rows contain invalid fill values. Do not guess a corrected balance.
2. Export D1 to a private backup outside the repository. Record the restore bookmark. Verify the export exists before migration.
3. Deploy a temporary maintenance handler that returns 503 without touching D1, keeping the existing Worker identity and Access perimeter. Drain in-flight requests before the schema change. Do not rely on the kill switch alone because old close requests can still write.
4. Export a final quiescent backup and record row counts/cash. Apply `wrangler d1 migrations apply pm-ai-trading-db --remote` once. The migration only adds columns, indexes, and triggers; it does not recalculate or delete existing trades.
5. Deploy the matching application. Verify unchanged historical rows/cash, current epoch, trigger/index presence, Access protection, and health. Clear the maintenance flag only with matching schema/code.

Old and new accounting writers must not coexist: old code manually credits/debits cash and would double-apply trigger accounting. Never roll back only the Worker after applying triggers. Before new writes, restore the database/application pair if necessary; after new writes, stop mutations and forward-fix.

## Local verification

Apply baseline plus migrations to a separate local D1 state and run the SQLite suites from the repository directory. The local D1 smoke test verified insert/close `RETURNING`: cash changed from 1000 to 990 on a 10-unit stake, then to 1010 on a 20-unit payout. Repeating the conditional close changed no row and left cash unchanged. These are synthetic local values, not production performance.

The independent ledger suite includes duplicate-operation retries, cap boundaries, kill switch, injected debit/credit failures, close replay, marks, reset epoch isolation, and invalid numeric inputs. Tests use real SQLite rather than canned query results. Concurrency tests with synchronous adapters establish interleaving behavior, not simultaneous database writers.

## Applied production upgrade

On 2026-11-16, the Worker was put into a no-D1 503 maintenance deployment, in-flight work was allowed to drain, and a final private D1 export was captured. Migration `0001_paper_ledger_integrity.sql` applied successfully. Matching deployment `592fc452-d270-4142-8c22-e3ec08d0f5fd` restored service. Post-upgrade inspection confirmed the same 700 units of paper cash and three open paper positions, epoch zero, revision zero, and all five accounting/history triggers. No production position was opened, closed, or reset for verification.

Review found two accounting edge cases: independently rounded P&L disagreed with credited half-cent proceeds, and inherited cap breaches blocked kill-switch-only edits. Both were reproduced with failing SQLite-backed tests and repaired. Realized P&L now uses the same rounded proceeds as the cash credit; cap checks apply only to caps included in the settings patch. Source typechecking excludes test files; tests execute via esbuild and Node.

