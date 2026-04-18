const { getDb, sql } = require('./db');
const config = require('./config');

async function openPosition(decisionId, signal) {
  const pool = await getDb();

  // Check if there's already an open position for this symbol
  const existing = await pool.request()
    .input('symbol', sql.VarChar(20), signal.symbol)
    .query("SELECT id FROM positions WHERE symbol = @symbol AND status = 'OPEN'");

  if (existing.recordset.length > 0) {
    return { action: 'SKIPPED', reason: 'Open position already exists for ' + signal.symbol };
  }

  const result = await pool.request()
    .input('decisionId', sql.BigInt, decisionId)
    .input('symbol', sql.VarChar(20), signal.symbol)
    .input('side', sql.VarChar(5), 'LONG')
    .input('amountUsd', sql.Decimal(18, 2), config.trading.tradeAmountUsd)
    .input('entryPrice', sql.Decimal(18, 8), signal.price)
    .query(`
      INSERT INTO positions (decision_id, symbol, side, amount_usd, entry_price)
      OUTPUT INSERTED.id
      VALUES (@decisionId, @symbol, @side, @amountUsd, @entryPrice)
    `);

  return { action: 'OPENED', positionId: result.recordset[0].id, symbol: signal.symbol, entryPrice: signal.price };
}

async function closePosition(decisionId, signal) {
  const pool = await getDb();

  // Find open LONG for this symbol
  const open = await pool.request()
    .input('symbol', sql.VarChar(20), signal.symbol)
    .query("SELECT * FROM positions WHERE symbol = @symbol AND status = 'OPEN' AND side = 'LONG'");

  if (open.recordset.length === 0) {
    return { action: 'SKIPPED', reason: 'No open position for ' + signal.symbol };
  }

  const position = open.recordset[0];
  const quantity = position.amount_usd / position.entry_price;
  const pnlUsd = (signal.price - position.entry_price) * quantity;
  const isWin = pnlUsd > 0;

  // Close position
  await pool.request()
    .input('id', sql.BigInt, position.id)
    .input('exitPrice', sql.Decimal(18, 8), signal.price)
    .input('pnlUsd', sql.Decimal(18, 2), pnlUsd)
    .query(`
      UPDATE positions
      SET exit_price = @exitPrice, pnl_usd = @pnlUsd, status = 'CLOSED', closed_at = GETDATE()
      WHERE id = @id
    `);

  // Update portfolio
  await pool.request()
    .input('pnl', sql.Decimal(18, 2), pnlUsd)
    .input('win', sql.Int, isWin ? 1 : 0)
    .query(`
      UPDATE portfolio
      SET current_balance = current_balance + @pnl,
          total_trades = total_trades + 1,
          winning_trades = winning_trades + @win,
          snapshot_at = GETDATE()
    `);

  return {
    action: 'CLOSED',
    positionId: position.id,
    symbol: signal.symbol,
    entryPrice: position.entry_price,
    exitPrice: signal.price,
    pnlUsd: Math.round(pnlUsd * 100) / 100,
    win: isWin,
  };
}

async function executeTrade(decision, signal) {
  if (signal.action === 'BUY') {
    return openPosition(decision.decisionId, signal);
  } else if (signal.action === 'SELL') {
    return closePosition(decision.decisionId, signal);
  }
  return { action: 'SKIPPED', reason: 'Unknown action: ' + signal.action };
}

module.exports = { executeTrade };
