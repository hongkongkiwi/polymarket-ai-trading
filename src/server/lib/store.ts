import type { SqlDb } from "./paper-ledger";
import type { Settings, Trade, Stats, TradingMode } from "../../shared/types";

interface SettingsRow {
  mode: string;
  paper_epoch: number;
  revision: number;
  bankroll: number;
  kelly_fraction: number;
  max_positions: number;
  max_position_usd: number;
  max_exposure_usd: number;
  min_volume_usd: number;
  favorite_threshold: number;
  longshot_min: number;
  longshot_max: number;
  ai_gating: number;
  kill_switch: number;
}

interface TradeRow {
  id: number;
  mode: string;
  paper_epoch: number;
  market_id: string;
  question: string;
  side: string;
  entry_price: number;
  size_usd: number;
  shares: number;
  status: string;
  pnl: number;
  exit_price: number | null;
  current_price: number | null;
  ai_confidence: number | null;
  reason: string;
  opened_at: string;
  closed_at: string | null;
}

export async function ensureSettings(db: SqlDb): Promise<void> {
  await db.run("INSERT OR IGNORE INTO settings (id) VALUES (1)");
}

function mapSettings(r: SettingsRow): Settings {
  return {
    mode: r.mode as TradingMode,
    paperEpoch: r.paper_epoch,
    revision: r.revision,
    bankroll: r.bankroll,
    kellyFraction: r.kelly_fraction,
    maxPositions: r.max_positions,
    maxPositionUsd: r.max_position_usd,
    maxExposureUsd: r.max_exposure_usd,
    minVolumeUsd: r.min_volume_usd,
    favoriteThreshold: r.favorite_threshold,
    longshotMin: r.longshot_min,
    longshotMax: r.longshot_max,
    aiGating: r.ai_gating === 1,
    killSwitch: r.kill_switch === 1,
  };
}

export async function getSettings(db: SqlDb): Promise<Settings> {
  const row = await db.get<SettingsRow>("SELECT * FROM settings WHERE id = 1");
  if (!row) throw new Error("Settings row is missing.");
  return mapSettings(row);
}

const SETTING_COLUMNS = {
  mode: "mode",
  bankroll: "bankroll",
  kellyFraction: "kelly_fraction",
  maxPositions: "max_positions",
  maxPositionUsd: "max_position_usd",
  maxExposureUsd: "max_exposure_usd",
  minVolumeUsd: "min_volume_usd",
  favoriteThreshold: "favorite_threshold",
  longshotMin: "longshot_min",
  longshotMax: "longshot_max",
  aiGating: "ai_gating",
  killSwitch: "kill_switch",
} as const;

export class SettingsError extends Error {
  constructor(message: string, readonly status: 400 | 409) { super(message); }
}

export async function updateSettings(db: SqlDb, input: unknown): Promise<Settings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SettingsError("A settings object is required.", 400);
  }
  const patch = input as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (key !== "revision" && key !== "paperEpoch" && !Object.hasOwn(SETTING_COLUMNS, key)) {
      throw new SettingsError(`Unknown setting: ${key}.`, 400);
    }
  }
  for (const key of ["revision", "paperEpoch"]) {
    if (!Number.isSafeInteger(patch[key]) || (patch[key] as number) < 0) {
      throw new SettingsError(`${key} must be a nonnegative integer.`, 400);
    }
  }
  for (const key of Object.keys(SETTING_COLUMNS)) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === "mode") {
      if (value !== "paper") throw new SettingsError("This deployment supports paper trading only.", 400);
    } else if (key === "aiGating" || key === "killSwitch") {
      if (typeof value !== "boolean") throw new SettingsError(`${key} must be boolean.`, 400);
    } else if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SettingsError(`${key} must be a finite number.`, 400);
    }
  }
  for (const key of ["bankroll", "maxPositionUsd", "maxExposureUsd"]) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key] as number;
    if (value <= 0 || value > 1_000_000_000 || round(value) !== value) {
      throw new SettingsError(`${key} must be positive whole cents, at most 1000000000 USD.`, 400);
    }
  }
  const current = await getSettings(db);
  const next = { ...current, ...patch } as Settings;
  if ((Object.hasOwn(patch, "bankroll") && next.bankroll <= 0) || next.maxPositionUsd <= 0 || next.maxExposureUsd <= 0) {
    throw new SettingsError("Cash and position caps must be positive.", 400);
  }
  if (!Number.isSafeInteger(next.maxPositions) || next.maxPositions < 1) {
    throw new SettingsError("maxPositions must be a positive integer.", 400);
  }
  if (next.kellyFraction <= 0 || next.kellyFraction > 1 || next.minVolumeUsd < 0 ||
      next.favoriteThreshold < 0.5 || next.favoriteThreshold >= 1 ||
      next.longshotMin <= 0 || next.longshotMax > 0.5 || next.longshotMin >= next.longshotMax) {
    throw new SettingsError("Strategy thresholds are out of bounds.", 400);
  }
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const [key, column] of Object.entries(SETTING_COLUMNS)) {
    if (!Object.hasOwn(patch, key)) continue;
    sets.push(`${column} = ?`);
    const value = patch[key] as string | number | boolean;
    vals.push(typeof value === "boolean" ? Number(value) : value);
  }
  // Cap predicates share the write's snapshot, so an intervening fill cannot bypass a reduction.
  const row = await db.get<SettingsRow>(
    `UPDATE settings SET ${sets.length ? `${sets.join(", ")}, ` : ""}revision = revision + 1
     WHERE id = 1 AND revision = ? AND paper_epoch = ? AND mode = 'paper'
       AND (? = 0 OR ? >= (SELECT COUNT(*) FROM trades WHERE mode = 'paper' AND paper_epoch = settings.paper_epoch AND status = 'open'))
       AND (? = 0 OR round(? * 100) >= (SELECT COALESCE(SUM(round(size_usd * 100)), 0) FROM trades WHERE mode = 'paper' AND paper_epoch = settings.paper_epoch AND status = 'open'))
       AND (? = 0 OR round(? * 100) >= (SELECT COALESCE(MAX(round(size_usd * 100)), 0) FROM trades WHERE mode = 'paper' AND paper_epoch = settings.paper_epoch AND status = 'open'))
     RETURNING *`,
    [...vals, patch.revision, patch.paperEpoch,
      Number(Object.hasOwn(patch, "maxPositions")), next.maxPositions,
      Number(Object.hasOwn(patch, "maxExposureUsd")), next.maxExposureUsd,
      Number(Object.hasOwn(patch, "maxPositionUsd")), next.maxPositionUsd],
  );
  if (!row) throw new SettingsError("Settings changed or caps are below active positions. Reload settings and retry.", 409);
  return mapSettings(row);
}

function mapTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    mode: r.mode as TradingMode,
    paperEpoch: r.paper_epoch,
    marketId: r.market_id,
    question: r.question,
    side: r.side as Trade["side"],
    entryPrice: r.entry_price,
    sizeUsd: r.size_usd,
    shares: r.shares,
    status: r.status as Trade["status"],
    pnl: r.pnl,
    exitPrice: r.exit_price,
    currentPrice: r.current_price,
    aiConfidence: r.ai_confidence,
    reason: r.reason,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}

export async function getTrade(db: SqlDb, id: number, epoch: number): Promise<Trade | null> {
  const row = await db.get<TradeRow>("SELECT * FROM trades WHERE id = ? AND mode = 'paper' AND paper_epoch = ?", [id, epoch]);
  return row ? mapTrade(row) : null;
}

export async function listTrades(db: SqlDb, limit = 200): Promise<Trade[]> {
  const rows = await db.query<TradeRow>(
    "SELECT * FROM trades WHERE mode = 'paper' ORDER BY opened_at DESC, id DESC LIMIT ?",
    [Math.max(1, Math.min(500, limit))],
  );
  return rows.map(mapTrade);
}

export async function listOpenTrades(db: SqlDb, epoch?: number): Promise<Trade[]> {
  const rows = await db.query<TradeRow>(
    `SELECT * FROM trades WHERE mode = 'paper' AND status = 'open'
     AND paper_epoch = ${epoch === undefined ? "(SELECT paper_epoch FROM settings WHERE id = 1)" : "?"}
     ORDER BY opened_at DESC`,
    epoch === undefined ? [] : [epoch],
  );
  return rows.map(mapTrade);
}

export async function getStats(db: SqlDb): Promise<Stats> {
  const row = await db.get<{
    bankroll: number; mode: TradingMode; paper_epoch: number; open_count: number; closed_count: number;
    open_exposure: number; unrealized_pnl: number; realized_pnl: number; wins: number;
  }>(`SELECT s.bankroll, s.mode, s.paper_epoch,
      COUNT(CASE WHEN t.status = 'open' THEN 1 END) AS open_count,
      COUNT(CASE WHEN t.status = 'closed' THEN 1 END) AS closed_count,
      COALESCE(SUM(CASE WHEN t.status = 'open' THEN t.size_usd ELSE 0 END), 0) AS open_exposure,
      COALESCE(SUM(CASE WHEN t.status = 'open' THEN t.pnl ELSE 0 END), 0) AS unrealized_pnl,
      COALESCE(SUM(CASE WHEN t.status = 'closed' THEN t.pnl ELSE 0 END), 0) AS realized_pnl,
      COUNT(CASE WHEN t.status = 'closed' AND t.pnl > 0 THEN 1 END) AS wins
    FROM settings s LEFT JOIN trades t ON t.mode = 'paper' AND t.paper_epoch = s.paper_epoch
    WHERE s.id = 1 GROUP BY s.id`);
  if (!row) throw new Error("Settings row is missing.");
  return {
    bankroll: row.bankroll,
    mode: row.mode,
    paperEpoch: row.paper_epoch,
    openCount: row.open_count,
    closedCount: row.closed_count,
    openExposure: round(row.open_exposure),
    unrealizedPnl: round(row.unrealized_pnl),
    realizedPnl: round(row.realized_pnl),
    winRate: row.closed_count ? round(row.wins / row.closed_count * 100) : 0,
  };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
