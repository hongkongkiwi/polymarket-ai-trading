import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createPaperLedger, type SqlDb } from "../src/server/lib/paper-ledger";

type OpenInput = Parameters<ReturnType<typeof createPaperLedger>["open"]>[0];
type Row = Record<string, unknown>;

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(join(process.cwd(), "src/server/schema.sql"), "utf8"));
  const migration = join(process.cwd(), "migrations/0001_paper_ledger_integrity.sql");
  if (existsSync(migration)) {
    sqlite.exec(readFileSync(migration, "utf8"));
  } else {
    // The declared schema permits qualifying the stub before its migration exists.
    sqlite.exec(`
      ALTER TABLE settings ADD COLUMN paper_epoch INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE trades ADD COLUMN paper_epoch INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE trades ADD COLUMN open_key TEXT;
      CREATE UNIQUE INDEX test_paper_open_key ON trades(open_key);
    `);
  }
  sqlite.exec("INSERT OR IGNORE INTO settings (id) VALUES (1)");
  const db: SqlDb = {
    async query<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).run(...params);
    },
  };
  const ledger = createPaperLedger(db);
  const settings = () => sqlite.prepare("SELECT * FROM settings WHERE id = 1").get() as Row;
  const trades = () => sqlite.prepare("SELECT * FROM trades ORDER BY id").all() as Row[];
  const trade = (id: number) => sqlite.prepare("SELECT * FROM trades WHERE id = ?").get(id) as Row;
  const snapshot = () => ({ settings: settings(), trades: trades() });
  function configure(patch: Record<string, number | string>) {
    const columns = Object.keys(patch);
    sqlite.prepare(`UPDATE settings SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = 1`)
      .run(...Object.values(patch));
  }
  function liveTrade() {
    const result = sqlite.prepare(`
      INSERT INTO trades (mode, market_id, side, entry_price, size_usd, shares, current_price, paper_epoch)
      VALUES ('live', 'live-market', 'YES', 0.5, 100, 200, 0.5, 0)
    `).run();
    return Number(result.lastInsertRowid);
  }
  return { sqlite, db, ledger, settings, trades, trade, snapshot, configure, liveTrade };
}

function order(patch: Partial<OpenInput> = {}): OpenInput {
  return {
    epoch: 0,
    key: "synthetic-open-key",
    marketId: "synthetic-market",
    question: "Will the synthetic event occur?",
    slug: "synthetic-event",
    side: "NO",
    price: 0.25,
    sizeUsd: 20,
    confidence: 0.8,
    reason: "Synthetic accounting fixture.",
    ...patch,
  };
}

function positionId(id: number | null): number {
  assert.equal(typeof id, "number", "an accepted order returns its persisted numeric id");
  assert.ok(Number.isInteger(id) && id! > 0);
  return id!;
}

async function rejectedWithoutMutation(
  call: () => Promise<unknown>,
  rejectedValue: null | false,
  snapshot: () => unknown,
) {
  const before = snapshot();
  let result: unknown;
  let rejected = false;
  try {
    result = await call();
  } catch (error) {
    assert.ok(error instanceof Error);
    rejected = true;
  }
  if (!rejected) assert.equal(result, rejectedValue);
  assert.deepEqual(snapshot(), before, "rejected numeric input must not change the ledger or cash");
}

test("SQLite fixture executes bound SQL and preserves schema defaults", async (t) => {
  const f = fixture(t);
  assert.equal(f.settings().paper_epoch, 0);
  assert.equal(f.settings().revision, 0);
  await f.db.run("UPDATE settings SET bankroll = ? WHERE id = ?", [321, 1]);
  assert.equal((await f.db.get<{ bankroll: number }>("SELECT bankroll FROM settings WHERE id = ?", [1]))?.bankroll, 321);
  assert.deepEqual(await f.db.query("SELECT market_id FROM trades"), []);
});

test("open atomically debits available cash and persists the supplied outcome fill", async (t) => {
  const f = fixture(t);
  const input = order();
  const id = positionId(await f.ledger.open(input));
  assert.equal(f.settings().bankroll, 980);
  assert.equal(f.trades().length, 1);
  const row = f.trade(id);
  for (const [column, expected] of Object.entries({
    mode: "paper", market_id: input.marketId, question: input.question, slug: input.slug,
    side: "NO", entry_price: 0.25, size_usd: 20, shares: 80, current_price: 0.25,
    status: "open", pnl: 0, ai_confidence: 0.8, reason: input.reason, paper_epoch: 0,
    open_key: input.key, exit_price: null, closed_at: null,
  })) assert.equal(row[column], expected, column);
  assert.equal(typeof row.opened_at, "string");
});

test("competing opens cannot spend more than available cash and exact cash is spendable", async (t) => {
  const f = fixture(t);
  f.configure({ bankroll: 100 });
  const results = await Promise.all([
    f.ledger.open(order({ key: "cash-a", marketId: "cash-a", sizeUsd: 60 })),
    f.ledger.open(order({ key: "cash-b", marketId: "cash-b", sizeUsd: 60 })),
  ]);
  assert.equal(results.filter((id) => id !== null).length, 1);
  assert.equal(results.filter((id) => id === null).length, 1);
  assert.equal(f.settings().bankroll, 40);
  positionId(await f.ledger.open(order({ key: "cash-boundary", marketId: "cash-boundary", sizeUsd: 40 })));
  const before = f.snapshot();
  assert.equal(f.settings().bankroll, 0);
  assert.equal(await f.ledger.open(order({ key: "cash-empty", marketId: "cash-empty", sizeUsd: 1 })), null);
  assert.deepEqual(f.snapshot(), before);
});

test("max_positions is enforced when two opens compete for the last slot", async (t) => {
  const f = fixture(t);
  f.configure({ max_positions: 1 });
  const results = await Promise.all([
    f.ledger.open(order({ key: "slot-a", marketId: "slot-a" })),
    f.ledger.open(order({ key: "slot-b", marketId: "slot-b" })),
  ]);
  assert.equal(results.filter((id) => id !== null).length, 1);
  assert.equal(results.filter((id) => id === null).length, 1);
  assert.equal(f.trades().length, 1);
  assert.equal(f.settings().bankroll, 980);
});

test("max_position_usd accepts its boundary and rejects a larger order without debit", async (t) => {
  const f = fixture(t);
  f.configure({ max_position_usd: 20 });
  positionId(await f.ledger.open(order()));
  const before = f.snapshot();
  assert.equal(await f.ledger.open(order({ key: "oversize", marketId: "oversize", sizeUsd: 20.01 })), null);
  assert.deepEqual(f.snapshot(), before);
});

test("max_exposure_usd is a commit-time aggregate cap with an inclusive boundary", async (t) => {
  const f = fixture(t);
  f.configure({ max_exposure_usd: 100 });
  const results = await Promise.all([
    f.ledger.open(order({ key: "exposure-a", marketId: "exposure-a", sizeUsd: 60 })),
    f.ledger.open(order({ key: "exposure-b", marketId: "exposure-b", sizeUsd: 60 })),
  ]);
  assert.equal(results.filter((id) => id !== null).length, 1);
  assert.equal(results.filter((id) => id === null).length, 1);
  positionId(await f.ledger.open(order({ key: "exposure-boundary", marketId: "exposure-boundary", sizeUsd: 40 })));
  const before = f.snapshot();
  assert.equal(await f.ledger.open(order({ key: "exposure-over", marketId: "exposure-over", sizeUsd: 0.01 })), null);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.settings().bankroll, 900);
});

test("opposite-side concurrent opens cannot duplicate a held market but a closed market can reopen", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([
    f.ledger.open(order({ key: "market-yes", side: "YES" })),
    f.ledger.open(order({ key: "market-no", side: "NO" })),
  ]);
  assert.equal(results.filter((id) => id !== null).length, 1);
  assert.equal(results.filter((id) => id === null).length, 1);
  const id = positionId(results.find((value) => value !== null)!);
  assert.equal(f.settings().bankroll, 980);
  assert.equal(await f.ledger.close(id, 0, 0.25), true);
  positionId(await f.ledger.open(order({ key: "market-reopened", confidence: null })));
  assert.equal(f.trades().length, 2);
  assert.equal(f.settings().bankroll, 980);
  assert.equal(f.trades()[1].ai_confidence, null);
});

test("an already-created ledger observes the kill switch before opening and can still close", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  f.configure({ kill_switch: 1 });
  const before = f.snapshot();
  assert.equal(await f.ledger.open(order({ key: "killed", marketId: "killed" })), null);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(await f.ledger.close(id, 0, 0.5), true);
  assert.equal(f.settings().bankroll, 1020);
});

test("same-key concurrent retries return one original id without charging again even after close", async (t) => {
  const f = fixture(t);
  const input = order();
  const results = await Promise.all([f.ledger.open(input), f.ledger.open({ ...input })]);
  const id = positionId(results[0]);
  assert.equal(results[1], id);
  assert.equal(f.trades().length, 1);
  assert.equal(f.settings().bankroll, 980);
  f.configure({ kill_switch: 1, max_positions: 0, max_position_usd: 0, max_exposure_usd: 0 });
  let before = f.snapshot();
  assert.equal(await f.ledger.open({ ...input }), id);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(await f.ledger.close(id, 0, 0.5), true);
  before = f.snapshot();
  assert.equal(await f.ledger.open({ ...input }), id);
  assert.deepEqual(f.snapshot(), before);
});

test("reusing an open key with a conflicting payload throws and preserves the original fill", async (t) => {
  const f = fixture(t);
  const input = order();
  positionId(await f.ledger.open(input));
  const before = f.snapshot();
  const conflicts: Partial<OpenInput>[] = [
    { marketId: "other-market" }, { question: "Another question?" }, { slug: "other-slug" },
    { side: "YES" }, { price: 0.5 }, { sizeUsd: 21 }, { confidence: null }, { reason: "Other reason." },
  ];
  for (const patch of conflicts) {
    await assert.rejects(() => f.ledger.open({ ...input, ...patch }));
    assert.deepEqual(f.snapshot(), before, `conflicting field ${Object.keys(patch)[0]}`);
  }
});

test("an injected trade insert failure rolls back the cash debit and permits a clean retry", async (t) => {
  const f = fixture(t);
  f.sqlite.exec(`CREATE TRIGGER fail_open BEFORE INSERT ON trades
    WHEN NEW.mode = 'paper' BEGIN SELECT RAISE(ABORT, 'synthetic_open_insert_failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.ledger.open(order()), /synthetic_open_insert_failure/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.exec("DROP TRIGGER fail_open");
  positionId(await f.ledger.open(order()));
  assert.equal(f.settings().bankroll, 980);
  assert.equal(f.trades().length, 1);
});

test("an injected cash debit failure cannot leave an inserted position behind", async (t) => {
  const f = fixture(t);
  f.sqlite.exec(`CREATE TRIGGER fail_debit BEFORE UPDATE OF bankroll ON settings
    WHEN NEW.bankroll < OLD.bankroll BEGIN SELECT RAISE(ABORT, 'synthetic_debit_failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.ledger.open(order()), /synthetic_debit_failure/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.exec("DROP TRIGGER fail_debit");
  positionId(await f.ledger.open(order()));
  assert.equal(f.settings().bankroll, 980);
});

test("concurrent close calls realize proceeds and PnL exactly once", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  const results = await Promise.all([f.ledger.close(id, 0, 0.5), f.ledger.close(id, 0, 0.5)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(f.settings().bankroll, 1020);
  const row = f.trade(id);
  assert.equal(row.status, "closed");
  assert.equal(row.exit_price, 0.5);
  assert.equal(row.current_price, 0.5);
  assert.equal(row.pnl, 20);
  assert.equal(typeof row.closed_at, "string");
  const before = f.snapshot();
  assert.equal(await f.ledger.close(id, 0, 1), false);
  assert.equal(await f.ledger.close(999999, 0, 0.5), false);
  assert.deepEqual(f.snapshot(), before);
});

test("settlement through close accepts zero and one and cannot pay either outcome twice", async (t) => {
  const f = fixture(t);
  const loser = positionId(await f.ledger.open(order({ key: "loser", marketId: "loser", side: "YES" })));
  const winner = positionId(await f.ledger.open(order({ key: "winner", marketId: "winner", side: "NO" })));
  assert.equal(await f.ledger.close(loser, 0, 0), true);
  assert.equal(await f.ledger.close(winner, 0, 1), true);
  assert.equal(f.settings().bankroll, 1040);
  assert.equal(f.trade(loser).pnl, -20);
  assert.equal(f.trade(loser).exit_price, 0);
  assert.equal(f.trade(winner).pnl, 60);
  assert.equal(f.trade(winner).exit_price, 1);
  const before = f.snapshot();
  assert.equal(await f.ledger.close(loser, 0, 1), false);
  assert.equal(await f.ledger.close(winner, 0, 1), false);
  assert.deepEqual(f.snapshot(), before);
});

test("a failed proceeds credit rolls back close and leaves the position retryable", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  f.sqlite.exec(`CREATE TRIGGER fail_credit BEFORE UPDATE OF bankroll ON settings
    WHEN NEW.bankroll > OLD.bankroll BEGIN SELECT RAISE(ABORT, 'synthetic_credit_failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.ledger.close(id, 0, 0.5), /synthetic_credit_failure/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.exec("DROP TRIGGER fail_credit");
  assert.equal(await f.ledger.close(id, 0, 0.5), true);
  assert.equal(f.settings().bankroll, 1020);
});

test("a failed trade close rolls back any cash credit", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  f.sqlite.exec(`CREATE TRIGGER fail_close BEFORE UPDATE OF status ON trades
    WHEN OLD.status = 'open' AND NEW.status = 'closed'
    BEGIN SELECT RAISE(ABORT, 'synthetic_close_failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.ledger.close(id, 0, 0.5), /synthetic_close_failure/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.exec("DROP TRIGGER fail_close");
  assert.equal(await f.ledger.close(id, 0, 0.5), true);
  assert.equal(f.settings().bankroll, 1020);
});

test("mark updates unrealized PnL including boundary prices without changing cash", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  const cash = f.settings().bankroll;
  for (const [price, pnl] of [[0.5, 20], [0, -20], [1, 60]]) {
    assert.equal(await f.ledger.mark(id, 0, price), true);
    const row = f.trade(id);
    assert.equal(row.current_price, price);
    assert.equal(row.pnl, pnl);
    assert.equal(row.status, "open");
    assert.equal(row.exit_price, null);
    assert.equal(row.closed_at, null);
    assert.equal(f.settings().bankroll, cash);
  }
});

test("mark and close ignore live, closed, missing, and wrong-epoch positions", async (t) => {
  const f = fixture(t);
  const active = positionId(await f.ledger.open(order()));
  const closed = positionId(await f.ledger.open(order({ key: "closed", marketId: "closed" })));
  assert.equal(await f.ledger.close(closed, 0, 0.5), true);
  const live = f.liveTrade();
  const before = f.snapshot();
  for (const [id, epoch] of [[live, 0], [closed, 0], [999999, 0], [active, 1]]) {
    assert.equal(await f.ledger.mark(id, epoch, 0.75), false);
    assert.equal(await f.ledger.close(id, epoch, 0.75), false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("reset is an epoch CAS that retains paper history, preserves live rows, and starts fresh limits", async (t) => {
  const f = fixture(t);
  const oldOpen = positionId(await f.ledger.open(order()));
  const oldClosed = positionId(await f.ledger.open(order({ key: "old-closed", marketId: "old-closed" })));
  assert.equal(await f.ledger.close(oldClosed, 0, 0.5), true);
  const closedBefore = f.trade(oldClosed);
  const openBefore = f.trade(oldOpen);
  const live = f.liveTrade();
  const liveBefore = f.trade(live);
  f.configure({ max_positions: 1, max_exposure_usd: 20 });
  const results = await Promise.all([f.ledger.reset(0, 500), f.ledger.reset(0, 500)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(f.settings().paper_epoch, 1);
  assert.equal(f.settings().bankroll, 500);
  assert.equal(f.trades().length, 3);
  assert.deepEqual(f.trade(oldClosed), closedBefore);
  assert.deepEqual(f.trade(live), liveBefore);
  assert.deepEqual(f.trade(oldOpen), openBefore);
  const before = f.snapshot();
  assert.equal(await f.ledger.reset(0, 999), false);
  assert.deepEqual(f.snapshot(), before);
  const fresh = positionId(await f.ledger.open(order({ epoch: 1, key: "fresh-session" })));
  assert.notEqual(fresh, oldOpen);
  assert.equal(f.trade(fresh).paper_epoch, 1);
  assert.equal(f.settings().bankroll, 480);
  assert.deepEqual(f.trade(live), liveBefore);
});

test("stale opens, closes, and marks cannot mutate the new session or old history after reset", async (t) => {
  const f = fixture(t);
  const input = order();
  const old = positionId(await f.ledger.open(input));
  assert.equal(await f.ledger.reset(0, 500), true);
  const fresh = positionId(await f.ledger.open(order({ epoch: 1, key: "current", marketId: "current" })));
  const before = f.snapshot();
  assert.equal(await f.ledger.open(order({ epoch: 0, key: "stale-new", marketId: "stale-new" })), null);
  assert.equal(await f.ledger.open(input), null);
  for (const [id, epoch] of [[old, 0], [old, 1], [fresh, 0]]) {
    assert.equal(await f.ledger.close(id, epoch, 1), false);
    assert.equal(await f.ledger.mark(id, epoch, 1), false);
  }
  assert.deepEqual(f.snapshot(), before);
});

test("an injected reset failure leaves cash, epoch, history, and live positions unchanged", async (t) => {
  const f = fixture(t);
  positionId(await f.ledger.open(order()));
  f.liveTrade();
  f.sqlite.exec(`CREATE TRIGGER fail_reset BEFORE UPDATE OF paper_epoch ON settings
    WHEN NEW.paper_epoch <> OLD.paper_epoch BEGIN SELECT RAISE(ABORT, 'synthetic_reset_failure'); END`);
  const before = f.snapshot();
  await assert.rejects(() => f.ledger.reset(0, 500), /synthetic_reset_failure/);
  assert.deepEqual(f.snapshot(), before);
  f.sqlite.exec("DROP TRIGGER fail_reset");
  assert.equal(await f.ledger.reset(0, 500), true);
  assert.equal(f.settings().paper_epoch, 1);
  assert.equal(f.settings().bankroll, 500);
});

test("open rejects zero, negative, nonfinite, and out-of-range amounts without mutation", async (t) => {
  const f = fixture(t);
  positionId(await f.ledger.open(order()));
  const invalid: Partial<OpenInput>[] = [
    ...[0, -0.1, 1.01, NaN, Infinity, -Infinity].map((price) => ({ price })),
    ...[0, -1, NaN, Infinity, -Infinity].map((sizeUsd) => ({ sizeUsd })),
  ];
  for (const [index, patch] of invalid.entries()) {
    await rejectedWithoutMutation(
      () => f.ledger.open(order({ key: `invalid-${index}`, marketId: `invalid-${index}`, ...patch })),
      null,
      f.snapshot,
    );
  }
});

test("close rejects negative, nonfinite, and greater-than-one exit prices without mutation", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  for (const price of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
    await rejectedWithoutMutation(() => f.ledger.close(id, 0, price), false, f.snapshot);
  }
});

test("mark rejects negative, nonfinite, and greater-than-one prices without mutation", async (t) => {
  const f = fixture(t);
  const id = positionId(await f.ledger.open(order()));
  for (const price of [-0.01, 1.01, NaN, Infinity, -Infinity]) {
    await rejectedWithoutMutation(() => f.ledger.mark(id, 0, price), false, f.snapshot);
  }
});

test("reset rejects negative and nonfinite bankrolls without changing session state", async (t) => {
  const f = fixture(t);
  positionId(await f.ledger.open(order()));
  for (const bankroll of [-1, NaN, Infinity, -Infinity]) {
    await rejectedWithoutMutation(() => f.ledger.reset(0, bankroll), false, f.snapshot);
  }
});
