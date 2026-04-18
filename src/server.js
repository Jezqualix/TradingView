const express = require('express');
const path = require('path');
const config = require('./config');
const { getDb, sql } = require('./db');
const { storeSignal } = require('./signalHandler');
const { analyze } = require('./claudeAnalyzer');
const { executeTrade } = require('./paperTrader');
const { notify } = require('./notifier');
const massive = require('./massive');
const { refreshAll, refreshOne } = require('./snapshotService');

const app = express();
app.use(express.json());

const exchangeCache = { stocks: [], crypto: [] };

async function preloadExchanges() {
  try {
    exchangeCache.stocks = await massive.getExchanges('stocks');
    exchangeCache.crypto = await massive.getExchanges('crypto');
    console.log(`[MASSIVE] Loaded ${exchangeCache.stocks.length} stock exchanges, ${exchangeCache.crypto.length} crypto exchanges`);
  } catch (err) {
    console.warn('[MASSIVE] Failed to preload exchanges:', err.message);
  }
}

// Serve dashboard
app.use(express.static(path.join(__dirname, 'dashboard')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Homepage API — ticker symbols with live prices
app.get('/api/symbols', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query(`
      SELECT
        t.id, t.symbol, t.name, t.asset_type, t.exchange,
        s.price, s.[open], s.high, s.low, s.prev_close,
        s.volume, s.vwap, s.change, s.change_pct,
        s.bid, s.ask, s.fetched_at
      FROM tickers t
      LEFT JOIN ticker_snapshots s ON s.ticker_id = t.id
      WHERE t.is_active = 1
      ORDER BY t.symbol
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('[SYMBOLS API]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/exchanges', (req, res) => {
  const type = req.query.type === 'crypto' ? 'crypto' : 'stocks';
  res.json(exchangeCache[type]);
});

app.post('/api/snapshots/refresh', async (req, res) => {
  try {
    const result = await refreshAll();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/snapshots/refresh/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const snapshot = await refreshOne(id);
    if (!snapshot) return res.status(404).json({ error: 'Ticker not found or snapshot failed' });
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook — full signal pipeline
app.post('/webhook', async (req, res) => {
  try {
    // 1. Store signal
    const signal = await storeSignal(req.body);
    console.log(`[SIGNAL] ${signal.symbol} ${signal.action} @ $${signal.price}`);

    // 2. Claude analysis
    const decision = await analyze(signal);
    console.log(`[DECISION] ${decision.decision} (${decision.confidence}%) — ${decision.reasoning.slice(0, 80)}`);

    // 3. Execute trade if conditions met
    let tradeResult = null;
    if (decision.decision === 'TRADE' && decision.confidence >= config.trading.confidenceThreshold) {
      tradeResult = await executeTrade(decision, signal);
      console.log(`[TRADE] ${tradeResult.action} — ${signal.symbol}`, tradeResult.pnlUsd !== undefined ? `P&L: $${tradeResult.pnlUsd}` : '');
    } else if (decision.decision === 'TRADE') {
      console.log(`[SKIP] Confidence ${decision.confidence}% below threshold ${config.trading.confidenceThreshold}%`);
    }

    // 4. Notify (never blocks response)
    notify(decision, signal, tradeResult).catch(err => console.error('[NOTIFY ERROR]', err.message));

    res.json({ signal, decision, trade: tradeResult });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// API endpoints for dashboard
app.get('/api/decisions', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query(`
      SELECT TOP 50 d.*, s.symbol, s.action, s.price, s.interval
      FROM decisions d
      JOIN signals s ON s.id = d.signal_id
      ORDER BY d.decided_at DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/positions', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query(`
      SELECT * FROM positions ORDER BY opened_at DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/portfolio', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query('SELECT TOP 1 * FROM portfolio ORDER BY id DESC');
    res.json(result.recordset[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query('SELECT TOP 30 * FROM claude_memory ORDER BY created_at DESC');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/strategies', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query('SELECT * FROM strategies ORDER BY skepticism_score DESC');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ticker lookup endpoint
app.get('/api/lookup-ticker', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol || symbol.trim().length === 0) {
      return res.status(400).json({ error: 'Symbol required' });
    }

    const result = await massive.lookupTicker(symbol);
    if (!result) {
      return res.json(null);
    }

    res.json({
      symbol: result.symbol,
      name: result.name,
      exchange: result.exchange,
      isCrypto: result.market === 'crypto',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin API — paginated table views
async function paginatedQuery(tableName, page = 1, orderBy = 'id DESC', joins = '') {
  const pageSize = 50;
  const offset = (page - 1) * pageSize;
  const pool = await getDb();

  const countResult = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${tableName}`);
  const total = countResult.recordset[0].cnt;

  const dataResult = await pool.request().query(`
    SELECT * FROM ${tableName} ${joins}
    ORDER BY ${orderBy}
    OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `);

  return {
    data: dataResult.recordset,
    total,
    page,
    pages: Math.ceil(total / pageSize),
  };
}

app.get('/api/admin/counts', async (req, res) => {
  try {
    const pool = await getDb();
    const tables = ['signals', 'decisions', 'positions', 'portfolio', 'strategies', 'claude_memory', 'tickers'];
    const counts = {};

    for (const table of tables) {
      const result = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${table}`);
      counts[table] = result.recordset[0].cnt;
    }

    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/signals', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const result = await paginatedQuery('signals', page, 'received_at DESC');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/decisions', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const pool = await getDb();
    const pageSize = 50;
    const offset = (page - 1) * pageSize;

    const countResult = await pool.request().query('SELECT COUNT(*) AS cnt FROM decisions');
    const total = countResult.recordset[0].cnt;

    const dataResult = await pool.request().query(`
      SELECT TOP ${pageSize} d.*, s.symbol, s.action, s.price
      FROM decisions d
      JOIN signals s ON s.id = d.signal_id
      ORDER BY d.decided_at DESC
      OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
    `);

    res.json({
      data: dataResult.recordset,
      total,
      page,
      pages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/positions', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const result = await paginatedQuery('positions', page, 'opened_at DESC');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/portfolio', async (req, res) => {
  try {
    const pool = await getDb();
    const result = await pool.request().query('SELECT * FROM portfolio ORDER BY snapshot_at DESC');
    res.json({ data: result.recordset, total: result.recordset.length, page: 1, pages: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/strategies', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const result = await paginatedQuery('strategies', page, 'last_updated DESC');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/memory', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const result = await paginatedQuery('claude_memory', page, 'created_at DESC');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tickers CRUD endpoints
app.get('/api/admin/tickers', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const result = await paginatedQuery('tickers', page, 'created_at DESC');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/tickers', async (req, res) => {
  try {
    const { symbol, name, asset_type, exchange, is_active } = req.body;

    // Validation
    if (!symbol || symbol.trim().length === 0 || symbol.length > 20) {
      return res.status(400).json({ error: 'Symbol required (max 20 chars)' });
    }
    if (!['STOCK', 'CRYPTO'].includes(asset_type)) {
      return res.status(400).json({ error: 'Asset type must be STOCK or CRYPTO' });
    }

    const pool = await getDb();
    const upperSymbol = symbol.toUpperCase().trim();

    const result = await pool.request()
      .input('symbol', sql.VarChar(20), upperSymbol)
      .input('name', sql.VarChar(100), name || null)
      .input('asset_type', sql.VarChar(10), asset_type)
      .input('exchange', sql.VarChar(50), exchange || null)
      .input('is_active', sql.Bit, is_active ? 1 : 0)
      .query(`
        INSERT INTO tickers (symbol, name, asset_type, exchange, is_active)
        VALUES (@symbol, @name, @asset_type, @exchange, @is_active);
        SELECT SCOPE_IDENTITY() AS id;
      `);

    const id = result.recordset[0].id;
    res.json({ id, symbol: upperSymbol, name, asset_type, exchange, is_active });
  } catch (err) {
    if (err.message.includes('UNIQUE KEY')) {
      return res.status(400).json({ error: 'Symbol already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tickers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { symbol, name, asset_type, exchange, is_active } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    if (!symbol || symbol.trim().length === 0 || symbol.length > 20) {
      return res.status(400).json({ error: 'Symbol required (max 20 chars)' });
    }
    if (!['STOCK', 'CRYPTO'].includes(asset_type)) {
      return res.status(400).json({ error: 'Asset type must be STOCK or CRYPTO' });
    }

    const pool = await getDb();
    const upperSymbol = symbol.toUpperCase().trim();

    await pool.request()
      .input('id', sql.BigInt, id)
      .input('symbol', sql.VarChar(20), upperSymbol)
      .input('name', sql.VarChar(100), name || null)
      .input('asset_type', sql.VarChar(10), asset_type)
      .input('exchange', sql.VarChar(50), exchange || null)
      .input('is_active', sql.Bit, is_active ? 1 : 0)
      .query(`
        UPDATE tickers SET symbol = @symbol, name = @name, asset_type = @asset_type,
        exchange = @exchange, is_active = @is_active
        WHERE id = @id
      `);

    res.json({ id, symbol: upperSymbol, name, asset_type, exchange, is_active });
  } catch (err) {
    if (err.message.includes('UNIQUE KEY')) {
      return res.status(400).json({ error: 'Symbol already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/tickers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid ID' });
    }

    const pool = await getDb();
    await pool.request()
      .input('id', sql.BigInt, id)
      .query('DELETE FROM tickers WHERE id = @id');

    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
async function start() {
  await getDb();
  console.log('Connected to MSSQL');

  const { startCron } = require('./strategyResearcher');
  startCron();

  app.listen(config.port, () => {
    console.log(`TradingView x Claude running on port ${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}`);
    console.log(`Webhook:   POST http://localhost:${config.port}/webhook`);
  });

  // Non-blocking warm-up after server is accepting connections
  await preloadExchanges();
  await refreshAll();
  setInterval(() => refreshAll().catch(err => console.error('[SNAPSHOT] Cron error:', err.message)), 5 * 60 * 1000);
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
