ALTER TABLE settings ADD COLUMN paper_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN paper_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN open_key TEXT;

CREATE UNIQUE INDEX idx_trades_open_key ON trades(open_key) WHERE open_key IS NOT NULL;
CREATE INDEX idx_trades_session ON trades(mode, paper_epoch, status, market_id);

CREATE TRIGGER paper_open_validate BEFORE INSERT ON trades WHEN NEW.mode = 'paper'
BEGIN
  SELECT CASE WHEN NEW.status != 'open' OR NEW.open_key IS NULL OR length(NEW.open_key) = 0
    OR typeof(NEW.size_usd) NOT IN ('integer', 'real') OR NEW.size_usd <= 0 OR NEW.size_usd > 1000000000
    OR NEW.size_usd != round(NEW.size_usd, 2)
    OR typeof(NEW.entry_price) NOT IN ('integer', 'real') OR NEW.entry_price <= 0 OR NEW.entry_price >= 1
    OR typeof(NEW.shares) NOT IN ('integer', 'real') OR NEW.shares <= 0
    OR abs(NEW.shares * NEW.entry_price - NEW.size_usd) > 0.000001
    OR NEW.side NOT IN ('YES', 'NO') OR length(NEW.market_id) = 0
    THEN RAISE(ABORT, 'invalid_paper_fill') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM settings WHERE id = 1 AND mode = 'paper' AND kill_switch = 0
      AND paper_epoch = NEW.paper_epoch
      AND round(bankroll * 100) >= round(NEW.size_usd * 100)
      AND round(max_position_usd * 100) >= round(NEW.size_usd * 100)
      AND (SELECT count(*) FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = NEW.paper_epoch) < max_positions
      AND coalesce((SELECT sum(round(size_usd * 100)) FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = NEW.paper_epoch), 0)
        + round(NEW.size_usd * 100) <= round(max_exposure_usd * 100)
      AND NOT EXISTS (SELECT 1 FROM trades WHERE mode = 'paper' AND status = 'open' AND paper_epoch = NEW.paper_epoch AND market_id = NEW.market_id)
  ) THEN RAISE(ABORT, 'paper_open_rejected') END;
END;

CREATE TRIGGER paper_open_debit AFTER INSERT ON trades WHEN NEW.mode = 'paper'
BEGIN
  UPDATE settings SET bankroll = round(bankroll - NEW.size_usd, 2), revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER paper_trade_immutable BEFORE UPDATE ON trades WHEN OLD.mode = 'paper'
BEGIN
  SELECT CASE WHEN NEW.mode != OLD.mode OR NEW.market_id != OLD.market_id OR NEW.paper_epoch != OLD.paper_epoch
    OR NEW.open_key IS NOT OLD.open_key OR NEW.entry_price != OLD.entry_price OR NEW.size_usd != OLD.size_usd OR NEW.shares != OLD.shares
    OR NEW.side != OLD.side OR NEW.opened_at != OLD.opened_at OR NEW.question != OLD.question OR NEW.slug != OLD.slug
    OR NEW.ai_confidence IS NOT OLD.ai_confidence OR NEW.reason != OLD.reason
    OR OLD.status != 'open' OR OLD.paper_epoch != (SELECT paper_epoch FROM settings WHERE id = 1)
    OR NEW.status NOT IN ('open', 'closed')
    THEN RAISE(ABORT, 'immutable_paper_trade') END;
  SELECT CASE WHEN NEW.current_price IS NOT NULL AND (
    typeof(NEW.current_price) NOT IN ('integer', 'real') OR NEW.current_price < 0 OR NEW.current_price > 1)
    THEN RAISE(ABORT, 'invalid_paper_mark') END;
  SELECT CASE WHEN NEW.status = 'closed' AND (NEW.exit_price IS NULL OR
    typeof(NEW.exit_price) NOT IN ('integer', 'real') OR NEW.exit_price < 0 OR NEW.exit_price > 1)
    THEN RAISE(ABORT, 'invalid_paper_exit') END;
END;

CREATE TRIGGER paper_close_credit AFTER UPDATE OF status ON trades
WHEN OLD.mode = 'paper' AND OLD.status = 'open' AND NEW.status = 'closed'
BEGIN
  UPDATE settings SET bankroll = round(bankroll + round(OLD.shares * NEW.exit_price, 2), 2), revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER paper_history_retained BEFORE DELETE ON trades WHEN OLD.mode = 'paper'
BEGIN
  SELECT RAISE(ABORT, 'paper_history_retained');
END;
