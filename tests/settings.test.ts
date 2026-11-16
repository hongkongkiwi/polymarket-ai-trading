import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { after, type TestContext } from "node:test";
import app from "../src/server/index";
import { createDb } from "../src/server/db";
import { createPaperLedger } from "../src/server/lib/paper-ledger";
import { closeTrade } from "../src/server/lib/engine";
import { getSettings, getStats, listOpenTrades, listTrades, updateSettings } from "../src/server/lib/store";
import { accessEnv, assertion, mockAccessFetch } from "./access-fixture";

after(mockAccessFetch());

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync("src/server/schema.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0001_paper_ledger_integrity.sql", "utf8"));
  sqlite.exec("INSERT INTO settings (id) VALUES (1)");
  const binding = {
    prepare(sql: string) {
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...params) }; },
        async first() { return sqlite.prepare(sql).get(...params) ?? null; },
        async run() { const result = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  const db = createDb(binding as unknown as D1Database);
  const env = { ...accessEnv, DB: binding, ASSETS: { fetch: async () => new Response("asset") } };
  const ledger = createPaperLedger(db);
  const order = (marketId = crypto.randomUUID(), sizeUsd = 20) => ledger.open({
    epoch: 0, key: crypto.randomUUID(), marketId, question: "Synthetic event?", slug: "synthetic-event",
    side: "NO", price: 0.25, sizeUsd, confidence: null, reason: "Settings fixture",
  });
  const request = (path: string, body: unknown, method = "PUT") => app.request(path, {
    method, headers: { "Cf-Access-Jwt-Assertion": assertion, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);
  return { sqlite, db, env, ledger, order, request };
}

function token(settings: { revision: number; paperEpoch: number }) {
  return { revision: settings.revision, paperEpoch: settings.paperEpoch };
}

test("settings API requires generation tokens and validates numbers, booleans, and bounds", async (t) => {
  const f = fixture(t);
  const original = await getSettings(f.db);
  for (const patch of [
    {}, { mode: "paper" }, { revision: -1, paperEpoch: 0 }, { revision: 0.5, paperEpoch: 0 },
    { bankroll: null }, { bankroll: "100" }, { bankroll: 0 }, { bankroll: -1 },
    { bankroll: 1_000_000_000.01 }, { bankroll: 1.001 }, { maxPositionUsd: 1.001 }, { maxExposureUsd: 1_000_000_001 },
    { maxPositions: 1.2 }, { maxPositions: 0 }, { maxPositionUsd: 0 }, { maxExposureUsd: -1 },
    { aiGating: 1 }, { killSwitch: "true" }, { kellyFraction: 1.1 }, { minVolumeUsd: -1 },
    { favoriteThreshold: 0.4 }, { longshotMin: 0 }, { longshotMin: 0.3, longshotMax: 0.2 },
    { longshotMax: 0.6 }, { unknownSetting: true },
  ]) {
    const body = Object.keys(patch).length <= 1 && ("mode" in patch || !Object.keys(patch).length)
      ? patch : { ...token(original), ...patch };
    const response = await f.request("/api/settings", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await getSettings(f.db), original);
  }
  for (const bankroll of [NaN, Infinity, -Infinity]) {
    await assert.rejects(updateSettings(f.db, { ...token(original), bankroll }), /finite number/);
  }
});

test("partial settings edits preserve cash and stale revisions or epochs return 409", async (t) => {
  const f = fixture(t);
  const original = await getSettings(f.db);
  const response = await f.request("/api/settings", { ...token(original), killSwitch: true });
  assert.equal(response.status, 200);
  const changed = await getSettings(f.db);
  assert.equal(changed.killSwitch, true);
  assert.equal(changed.bankroll, 1000);
  assert.equal(changed.revision, original.revision + 1);
  assert.equal((await f.request("/api/settings", { ...token(original), bankroll: 2000 })).status, 409);
  assert.equal((await f.request("/api/settings", { ...token(changed), paperEpoch: changed.paperEpoch + 1, aiGating: false })).status, 409);
  assert.deepEqual(await getSettings(f.db), changed);
});

test("ledger cash changes invalidate an old settings draft and zero cash still permits safety edits", async (t) => {
  const f = fixture(t);
  const original = await getSettings(f.db);
  const id = await f.order();
  assert.ok(id);
  assert.equal((await f.request("/api/settings", { ...token(original), bankroll: 1000 })).status, 409);
  const current = await getSettings(f.db);
  assert.equal(current.bankroll, 980);
  assert.ok(current.revision > original.revision);
  await updateSettings(f.db, { ...token(current), bankroll: 20 });
  await f.order(crypto.randomUUID(), 20);
  const empty = await getSettings(f.db);
  assert.equal(empty.bankroll, 0);
  const safe = await updateSettings(f.db, { ...token(empty), killSwitch: true });
  assert.equal(safe.killSwitch, true);
  assert.equal(safe.bankroll, 0);
});

test("cap reductions compare active count, aggregate exposure, and largest position atomically", async (t) => {
  const f = fixture(t);
  await f.order(crypto.randomUUID(), 30);
  await f.order(crypto.randomUUID(), 20);
  const current = await getSettings(f.db);
  for (const patch of [{ maxPositions: 1 }, { maxExposureUsd: 49.99 }, { maxPositionUsd: 29.99 }]) {
    assert.equal((await f.request("/api/settings", { ...token(current), ...patch })).status, 409);
    assert.deepEqual(await getSettings(f.db), current);
  }
  const next = await updateSettings(f.db, { ...token(current), maxPositions: 2, maxExposureUsd: 50, maxPositionUsd: 30 });
  assert.equal(next.maxExposureUsd, 50);
  for (const [column, value] of [["max_positions", 1], ["max_exposure_usd", 49.99], ["max_position_usd", 29.99]] as const) {
    f.sqlite.prepare("UPDATE settings SET max_positions = 2, max_exposure_usd = 50, max_position_usd = 30, kill_switch = 0 WHERE id = 1").run();
    f.sqlite.prepare(`UPDATE settings SET ${column} = ? WHERE id = 1`).run(value);
    const breached = await getSettings(f.db);
    const safety = await f.request("/api/settings", { ...token(breached), killSwitch: true });
    assert.equal(safety.status, 200, `safety edit must work despite inherited ${column} breach`);
    assert.equal((await getSettings(f.db)).killSwitch, true);
    assert.equal((await f.request("/api/settings", { ...token(breached), killSwitch: false })).status, 409);
  }
});

test("reset requires explicit valid cash and epoch, retains history, and excludes old positions from stats", async (t) => {
  const f = fixture(t);
  await f.order();
  for (const body of [{}, { bankroll: 500 }, { paperEpoch: 0 }, { bankroll: 0, paperEpoch: 0 },
    { bankroll: "500", paperEpoch: 0 }, { bankroll: null, paperEpoch: 0 }, { bankroll: 500, paperEpoch: 0.5 },
    { bankroll: 1.001, paperEpoch: 0 }, { bankroll: 1_000_000_000.01, paperEpoch: 0 }]) {
    assert.equal((await f.request("/api/reset", body, "POST")).status, 400);
  }
  const response = await f.request("/api/reset", { bankroll: 500, paperEpoch: 0 }, "POST");
  assert.equal(response.status, 200);
  assert.equal((await f.request("/api/reset", { bankroll: 500, paperEpoch: 0 }, "POST")).status, 409);
  const stats = await getStats(f.db);
  assert.equal(stats.paperEpoch, 1);
  assert.equal(stats.bankroll, 500);
  assert.equal(stats.openCount, 0);
  assert.equal(stats.openExposure, 0);
  assert.equal((await listOpenTrades(f.db)).length, 0);
  const history = await listTrades(f.db);
  assert.equal(history.length, 1);
  assert.equal(history[0].paperEpoch, 0);
});

test("manual close returns a mapped trade and credits cash only once", async (t) => {
  const f = fixture(t);
  const id = await f.order();
  assert.ok(id);
  const trade = await closeTrade(f.db, id!);
  assert.equal(trade?.marketId.length, 36);
  assert.equal(trade?.side, "NO");
  assert.equal(trade?.entryPrice, 0.25);
  assert.equal(trade?.status, "closed");
  assert.equal((await getStats(f.db)).bankroll, 1000);
  assert.equal(await closeTrade(f.db, id!), null);
  assert.equal((await getStats(f.db)).bankroll, 1000);
});

test("independent request-bound databases cannot overwrite each other's settings", async (t) => {
  const a = fixture(t);
  const b = fixture(t);
  await Promise.all([
    updateSettings(a.db, { ...token(await getSettings(a.db)), bankroll: 700 }),
    updateSettings(b.db, { ...token(await getSettings(b.db)), bankroll: 300 }),
  ]);
  assert.equal((await getSettings(a.db)).bankroll, 700);
  assert.equal((await getSettings(b.db)).bankroll, 300);
});

test("maintenance blocks encoded API requests before any database access but still serves assets", async () => {
  const env = {
    ...accessEnv, LEDGER_MAINTENANCE: "true",
    DB: { prepare() { throw new Error("Unexpected DB access"); } },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  for (const path of ["/api/settings", "/api/%73ettings", "/api", "/api/reset"]) {
    const response = await app.request(path, { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env);
    assert.equal(response.status, 503);
  }
  assert.equal((await app.request("/", { headers: { "Cf-Access-Jwt-Assertion": assertion } }, env)).status, 200);
});
