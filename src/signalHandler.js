const { getDb, sql } = require('./db');

async function storeSignal(payload) {
  const { symbol, action, price, interval, rsi, macd, ema_fast, ema_slow } = payload;

  if (!symbol || !action || !price) {
    throw new Error('Missing required fields: symbol, action, price');
  }

  const upperAction = action.toUpperCase();
  if (upperAction !== 'BUY' && upperAction !== 'SELL') {
    throw new Error('action must be BUY or SELL');
  }

  const pool = await getDb();
  const result = await pool.request()
    .input('symbol', sql.VarChar(20), symbol.toUpperCase())
    .input('action', sql.VarChar(10), upperAction)
    .input('price', sql.Decimal(18, 8), parseFloat(price))
    .input('interval', sql.VarChar(10), interval || null)
    .input('rsi', sql.Decimal(5, 2), rsi != null ? parseFloat(rsi) : null)
    .input('macd', sql.Decimal(10, 6), macd != null ? parseFloat(macd) : null)
    .input('ema_fast', sql.Decimal(18, 8), ema_fast != null ? parseFloat(ema_fast) : null)
    .input('ema_slow', sql.Decimal(18, 8), ema_slow != null ? parseFloat(ema_slow) : null)
    .input('raw_payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(`
      INSERT INTO signals (symbol, action, price, interval, rsi, macd, ema_fast, ema_slow, raw_payload)
      OUTPUT INSERTED.id
      VALUES (@symbol, @action, @price, @interval, @rsi, @macd, @ema_fast, @ema_slow, @raw_payload)
    `);

  return { signalId: result.recordset[0].id, symbol: symbol.toUpperCase(), action: upperAction, price: parseFloat(price) };
}

module.exports = { storeSignal };
