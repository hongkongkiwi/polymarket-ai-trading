import { fetchGammaMarkets, fetchGammaMarket, parseOutcomePrices } from "./gamma";
import { toMarket } from "./quality";
import { findSignals } from "./signals";
import { kellySize } from "./kelly";
import { gateSignal } from "./ai";
import { createPaperLedger, type SqlDb } from "./paper-ledger";
import { getSettings, getTrade, listOpenTrades, round } from "./store";
import type { Trade } from "../../shared/types";

const MAX_OPENS_PER_CYCLE = 3;

export interface CycleResult {
  scanned: number;
  signals: number;
  opened: number;
  skipped: number;
  notes: string[];
}

export async function runCycle(db: SqlDb, env: Record<string, string | undefined>): Promise<CycleResult> {
  const cfg = await getSettings(db);
  const epoch = cfg.paperEpoch;
  const notes: string[] = [];
  if (cfg.mode !== "paper") throw new Error("This deployment supports paper trading only.");
  if (cfg.killSwitch) return { scanned: 0, signals: 0, opened: 0, skipped: 0, notes: ["Kill switch is on. No trades opened."] };

  const raw = await fetchGammaMarkets({ limit: 200 });
  const signals = findSignals(raw, cfg);
  const open = await listOpenTrades(db, epoch);
  const heldMarkets = new Set(open.map((t) => t.marketId));
  let exposure = open.reduce((s, t) => s + t.sizeUsd, 0);
  let openCount = open.length;
  let bankroll = cfg.bankroll;
  const ledger = createPaperLedger(db);
  const aiActive = cfg.aiGating && Boolean(env.OPENROUTER_API_KEY);
  let opened = 0;
  let skipped = 0;

  for (const sig of signals) {
    if (opened >= MAX_OPENS_PER_CYCLE) break;
    if (openCount >= cfg.maxPositions) {
      notes.push("Reached max open positions.");
      break;
    }
    if (heldMarkets.has(sig.marketId)) {
      skipped++;
      continue;
    }
    let confidence = 0.5;
    if (aiActive) {
      try {
        const gate = await gateSignal(env, sig);
        if (!gate.take) {
          skipped++;
          continue;
        }
        confidence = gate.confidence;
      } catch (e) {
        notes.push(`AI gate failed, skipping ${sig.marketId}: ${(e as Error).message}`);
        skipped++;
        continue;
      }
    }
    const size = round(kellySize(sig.edge, sig.price, bankroll, cfg.kellyFraction, cfg.maxPositionUsd, confidence));
    if (size <= 0) {
      skipped++;
      continue;
    }
    if (size > bankroll) break;
    if (exposure + size > cfg.maxExposureUsd) {
      notes.push("Reached max exposure cap.");
      break;
    }
    const id = await ledger.open({
      epoch,
      key: crypto.randomUUID(),
      marketId: sig.marketId,
      question: sig.question,
      slug: sig.slug,
      side: sig.side,
      price: sig.price,
      sizeUsd: size,
      confidence: aiActive ? confidence : null,
      reason: sig.reason,
    });
    if (id === null) {
      skipped++;
      continue;
    }
    bankroll = round(bankroll - size);
    exposure += size;
    openCount++;
    heldMarkets.add(sig.marketId);
    opened++;
  }
  return { scanned: raw.length, signals: signals.length, opened, skipped, notes };
}

export interface MarkResult {
  repriced: number;
  settled: number;
}

export async function markToMarket(db: SqlDb): Promise<MarkResult> {
  const { paperEpoch: epoch } = await getSettings(db);
  const open = await listOpenTrades(db, epoch);
  if (!open.length) return { repriced: 0, settled: 0 };
  const ledger = createPaperLedger(db);
  const live = await fetchGammaMarkets({ limit: 500 });
  const byId = new Map(live.map((m) => [String(m.id ?? ""), m]));
  let repriced = 0;
  let settled = 0;
  for (const t of open) {
    let market = byId.get(t.marketId) || null;
    if (!market) market = await fetchGammaMarket(t.marketId);
    if (!market) continue;
    const m = toMarket(market);
    const price = t.side === "YES" ? m.yes : m.no;
    if (price == null) continue;
    // Existing resolution inference is unchanged; authoritative resolution remains a separate gap.
    const resolved = market.closed === true || price <= 0.001 || price >= 0.999;
    if (resolved) {
      const exit = price >= 0.5 ? (price >= 0.999 ? 1 : price) : (price <= 0.001 ? 0 : price);
      if (await ledger.close(t.id, epoch, exit)) settled++;
    } else if (await ledger.mark(t.id, epoch, price)) {
      repriced++;
    }
  }
  return { repriced, settled };
}

export async function closeTrade(db: SqlDb, id: number): Promise<Trade | null> {
  const { paperEpoch: epoch } = await getSettings(db);
  const t = await getTrade(db, id, epoch);
  if (!t || t.status !== "open") return null;
  // Existing last-price fallback is unchanged; fresh executable pricing is a separate gap.
  let price = t.currentPrice;
  if (price == null) {
    const market = await fetchGammaMarket(t.marketId);
    if (market) {
      const [yes, no] = parseOutcomePrices(market);
      price = t.side === "YES" ? yes : no;
    }
  }
  if (price == null) price = t.entryPrice;
  if (!await createPaperLedger(db).close(id, epoch, price)) return null;
  return getTrade(db, id, epoch);
}

export async function resetPaper(db: SqlDb, epoch: number, bankroll: number): Promise<boolean> {
  return createPaperLedger(db).reset(epoch, bankroll);
}
