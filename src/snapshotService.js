const { getDb, sql } = require('./db');
const massive = require('./massive');

let _refreshInProgress = false;

async function refreshAll() {
  if (_refreshInProgress) {
    console.log('[SNAPSHOT] Refresh already in progress, skipping');
    return { refreshed: 0, failed: 0, skipped: true };
  }
  _refreshInProgress = true;
  try {
    const pool = await getDb();
    const result = await pool.request().query(
      `SELECT id, symbol, asset_type FROM tickers WHERE is_active = 1`
    );

    let refreshed = 0;
    let failed = 0;

    for (const ticker of result.recordset) {
      const ok = await _upsertSnapshot(pool, ticker.id, ticker.symbol, ticker.asset_type);
      if (ok) refreshed++; else failed++;
    }

    console.log(`[SNAPSHOT] Refreshed ${refreshed} tickers, ${failed} failed`);
    return { refreshed, failed };
  } finally {
    _refreshInProgress = false;
  }
}

async function refreshOne(tickerId) {
  const pool = await getDb();
  const result = await pool.request()
    .input('id', sql.Int, tickerId)
    .query(`SELECT id, symbol, asset_type FROM tickers WHERE id = @id`);

  if (result.recordset.length === 0) return null;

  const ticker = result.recordset[0];
  const ok = await _upsertSnapshot(pool, ticker.id, ticker.symbol, ticker.asset_type);
  if (!ok) return null;

  const snap = await pool.request()
    .input('id', sql.Int, tickerId)
    .query(`SELECT * FROM ticker_snapshots WHERE ticker_id = @id`);

  return snap.recordset[0] || null;
}

async function _upsertSnapshot(pool, tickerId, symbol, assetType) {
  try {
    const snap = await massive.getSnapshot(symbol, assetType);
    if (!snap) return false;

    await pool.request()
      .input('ticker_id',  sql.Int,          tickerId)
      .input('price',      sql.Decimal(18,6), snap.price)
      .input('open',       sql.Decimal(18,6), snap.open)
      .input('high',       sql.Decimal(18,6), snap.high)
      .input('low',        sql.Decimal(18,6), snap.low)
      .input('prev_close', sql.Decimal(18,6), snap.prev_close)
      .input('volume',     sql.BigInt,        snap.volume)
      .input('vwap',       sql.Decimal(18,6), snap.vwap)
      .input('change',     sql.Decimal(18,6), snap.change)
      .input('change_pct', sql.Decimal(10,4), snap.change_pct)
      .input('bid',        sql.Decimal(18,6), snap.bid)
      .input('ask',        sql.Decimal(18,6), snap.ask)
      .query(`
        MERGE ticker_snapshots AS target
        USING (SELECT @ticker_id AS ticker_id) AS source ON target.ticker_id = source.ticker_id
        WHEN MATCHED THEN UPDATE SET
          price = @price, [open] = @open, high = @high, low = @low,
          prev_close = @prev_close, volume = @volume, vwap = @vwap,
          change = @change, change_pct = @change_pct,
          bid = @bid, ask = @ask, fetched_at = GETDATE()
        WHEN NOT MATCHED THEN INSERT
          (ticker_id, price, [open], high, low, prev_close, volume, vwap, change, change_pct, bid, ask)
        VALUES
          (@ticker_id, @price, @open, @high, @low, @prev_close, @volume, @vwap, @change, @change_pct, @bid, @ask);
      `);

    return true;
  } catch (err) {
    console.warn(`[SNAPSHOT] Failed to upsert ${symbol}:`, err.message);
    return false;
  }
}

module.exports = { refreshAll, refreshOne };
