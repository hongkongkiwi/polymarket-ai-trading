import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPaperLedger, type SqlDb } from "../src/server/lib/paper-ledger";

test("migration preserves historical paper/live rows and cash without replaying accounting", async (t) => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync(join(process.cwd(), "src/server/schema.sql"), "utf8"));
  sql.exec(`INSERT INTO settings(id,bankroll) VALUES(1,700);
    INSERT INTO trades(mode,market_id,side,entry_price,size_usd,shares,status,current_price)
    VALUES('paper','legacy-open','YES',0.5,100,200,'open',0.5),
      ('paper','legacy-closed','NO',0.25,50,200,'closed',1),
      ('live','legacy-live','YES',0.5,10,20,'open',0.5);`);
  const before = sql.prepare("SELECT * FROM trades ORDER BY id").all();
  sql.exec(readFileSync(join(process.cwd(), "migrations/0001_paper_ledger_integrity.sql"), "utf8"));
  for (const row of before) {
    const after = sql.prepare("SELECT * FROM trades WHERE id=?").get(row.id)!;
    for (const [key, value] of Object.entries(row)) assert.equal(after[key], value, key);
    assert.equal(after.paper_epoch, 0);
    assert.equal(after.open_key, null);
  }
  assert.equal(sql.prepare("SELECT bankroll FROM settings").get()!.bankroll, 700);
  const db: SqlDb = {
    async get<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).get(...params) as T | undefined; },
    async query<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).all(...params) as T[]; },
    async run(statement: string, params: unknown[] = []) { return sql.prepare(statement).run(...params); },
  };
  const ledger = createPaperLedger(db);
  assert.equal(await ledger.close(1, 0, 1), true);
  assert.equal(await ledger.close(1, 0, 1), false);
  assert.equal(sql.prepare("SELECT bankroll FROM settings").get()!.bankroll, 900);
  assert.equal(await ledger.reset(0, 1000), true);
  assert.equal(await ledger.close(3, 0, 1), false);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM trades").get()!.n, 3);
});

test("realized PnL uses the rounded proceeds actually credited to cash", async (t) => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync(join(process.cwd(), "src/server/schema.sql"), "utf8"));
  sql.exec(readFileSync(join(process.cwd(), "migrations/0001_paper_ledger_integrity.sql"), "utf8"));
  sql.exec("INSERT INTO settings(id,bankroll) VALUES(1,0.10)");
  const db: SqlDb = {
    async get<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).get(...params) as T | undefined; },
    async query<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).all(...params) as T[]; },
    async run(statement: string, params: unknown[] = []) { return sql.prepare(statement).run(...params); },
  };
  const ledger = createPaperLedger(db);
  const id = await ledger.open({ epoch: 0, key: "synthetic-half-cent", marketId: "synthetic-cent", question: "Synthetic?", slug: "synthetic", side: "YES", price: 0.5, sizeUsd: 0.01, confidence: null, reason: "test" });
  assert.equal(await ledger.close(id!, 0, 0.25), true);
  const cash = sql.prepare("SELECT bankroll FROM settings").get()!.bankroll as number;
  const pnl = sql.prepare("SELECT pnl FROM trades WHERE id=?").get(id!)!.pnl;
  assert.equal(cash, 0.10);
  assert.equal(pnl, Math.round((cash - 0.10) * 100) / 100);
});

test("competing conflicting operation keys cannot borrow a committed result", async (t) => {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec(readFileSync(join(process.cwd(), "src/server/schema.sql"), "utf8"));
  sql.exec(readFileSync(join(process.cwd(), "migrations/0001_paper_ledger_integrity.sql"), "utf8"));
  sql.exec("INSERT INTO settings(id) VALUES(1)");
  const db: SqlDb = {
    async get<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).get(...params) as T | undefined; },
    async query<T>(statement: string, params: unknown[] = []) { return sql.prepare(statement).all(...params) as T[]; },
    async run(statement: string, params: unknown[] = []) { return sql.prepare(statement).run(...params); },
  };
  const ledger = createPaperLedger(db);
  const order = { epoch: 0, key: "synthetic-race", marketId: "synthetic-market", question: "Synthetic?", slug: "synthetic", side: "YES" as const, price: 0.5, sizeUsd: 10, confidence: null, reason: "test" };
  const results = await Promise.allSettled([ledger.open(order), ledger.open({ ...order, sizeUsd: 20 })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM trades").get()!.n, 1);
  assert.equal(sql.prepare("SELECT bankroll FROM settings").get()!.bankroll, 990);
});
