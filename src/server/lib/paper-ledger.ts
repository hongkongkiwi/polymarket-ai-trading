export interface SqlDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
}

interface OpenInput {
  epoch: number;
  key: string;
  marketId: string;
  question: string;
  slug: string;
  side: "YES" | "NO";
  price: number;
  sizeUsd: number;
  confidence: number | null;
  reason: string;
}

function epochValid(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 0;
}

function money(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) throw new Error("Invalid paper cash amount.");
  return Math.round(value * 100) / 100;
}

function priceValid(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createPaperLedger(db: SqlDb) {
  return {
    async open(input: OpenInput): Promise<number | null> {
      const size = money(input.sizeUsd);
      if (!epochValid(input.epoch) || !input.key || !input.marketId || !priceValid(input.price) ||
          input.price === 0 || input.price === 1 || size <= 0 || !["YES", "NO"].includes(input.side) ||
          (input.confidence !== null && !priceValid(input.confidence))) throw new Error("Invalid paper fill.");
      const matches = (row: Record<string, unknown>): number => {
        if (row.mode !== "paper" || row.paper_epoch !== input.epoch || row.market_id !== input.marketId ||
            row.question !== input.question || row.slug !== input.slug || row.side !== input.side ||
            row.entry_price !== input.price || row.size_usd !== size || row.ai_confidence !== input.confidence ||
            row.reason !== input.reason) throw new Error("Paper operation key conflicts with its original fill.");
        return row.id as number;
      };
      const current = await db.get<{ paper_epoch: number }>("SELECT paper_epoch FROM settings WHERE id = 1");
      if (current?.paper_epoch !== input.epoch) return null;
      const existing = await db.get<Record<string, unknown>>("SELECT * FROM trades WHERE open_key = ?", [input.key]);
      if (existing) return matches(existing);
      const rows = await db.query<{ id: number }>(
        `INSERT INTO trades (mode, paper_epoch, open_key, market_id, question, slug, side, entry_price, size_usd, shares, status, current_price, ai_confidence, reason)
         SELECT 'paper', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ? FROM settings s
         WHERE s.id = 1 AND s.mode = 'paper' AND s.paper_epoch = ? AND s.kill_switch = 0
           AND round(s.bankroll * 100) >= round(? * 100) AND round(s.max_position_usd * 100) >= round(? * 100)
           AND (SELECT count(*) FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = s.paper_epoch) < s.max_positions
           AND coalesce((SELECT sum(round(size_usd * 100)) FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = s.paper_epoch), 0) + round(? * 100) <= round(s.max_exposure_usd * 100)
           AND NOT EXISTS (SELECT 1 FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = s.paper_epoch AND market_id = ?)
           AND NOT EXISTS (SELECT 1 FROM trades WHERE open_key = ?)
         RETURNING id`,
        [input.epoch, input.key, input.marketId, input.question, input.slug, input.side, input.price, size, size / input.price,
          input.price, input.confidence, input.reason, input.epoch, size, size, size, input.marketId, input.key],
      );
      if (rows[0]) return rows[0].id;
      // A competing retry may have committed between the initial read and insert.
      const retry = await db.get<Record<string, unknown>>(
        "SELECT * FROM trades WHERE open_key = ? AND paper_epoch = ? AND paper_epoch = (SELECT paper_epoch FROM settings WHERE id = 1)",
        [input.key, input.epoch],
      );
      return retry ? matches(retry) : null;
    },

    async close(id: number, epoch: number, price: number): Promise<boolean> {
      if (!epochValid(epoch) || !Number.isSafeInteger(id) || id <= 0 || !priceValid(price)) throw new Error("Invalid paper close.");
      const rows = await db.query<{ id: number }>(
        `UPDATE trades SET status = 'closed', exit_price = ?, current_price = ?, pnl = round(round(shares * ?, 2) - size_usd, 2), closed_at = datetime('now')
         WHERE id = ? AND mode = 'paper' AND status = 'open' AND paper_epoch = ?
           AND paper_epoch = (SELECT paper_epoch FROM settings WHERE id = 1) RETURNING id`,
        [price, price, price, id, epoch],
      );
      return rows.length === 1;
    },

    async mark(id: number, epoch: number, price: number): Promise<boolean> {
      if (!epochValid(epoch) || !Number.isSafeInteger(id) || id <= 0 || !priceValid(price)) throw new Error("Invalid paper mark.");
      const rows = await db.query<{ id: number }>(
        `UPDATE trades SET current_price = ?, pnl = round(shares * (? - entry_price), 2)
         WHERE id = ? AND mode = 'paper' AND status = 'open' AND paper_epoch = ?
           AND paper_epoch = (SELECT paper_epoch FROM settings WHERE id = 1) RETURNING id`,
        [price, price, id, epoch],
      );
      return rows.length === 1;
    },

    async reset(epoch: number, bankroll: number): Promise<boolean> {
      if (!epochValid(epoch)) throw new Error("Invalid paper session.");
      const cash = money(bankroll);
      const rows = await db.query<{ paper_epoch: number }>(
        "UPDATE settings SET paper_epoch = paper_epoch + 1, bankroll = ?, revision = revision + 1 WHERE id = 1 AND mode = 'paper' AND paper_epoch = ? RETURNING paper_epoch",
        [cash, epoch],
      );
      return rows.length === 1;
    },
  };
}
