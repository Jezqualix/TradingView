const express = require('express');
const path = require('path');
const config = require('./config');
const { getDb, sql } = require('./db');
const { storeSignal } = require('./signalHandler');
const { analyze } = require('./claudeAnalyzer');
const { executeTrade } = require('./paperTrader');
const { notify } = require('./notifier');
const finnhub = require('./finnhub');

let yahooFinance = null;
(async () => {
  try {
    yahooFinance = (await import('yahoo-finance2')).default;
  } catch (err) {
    console.warn('[YAHOO] Import failed, using fallback:', err.message);
  }
})();

const app = express();
app.use(express.json());

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

    // Get unique symbols from signals
    const symbolResult = await pool.request().query(`
      SELECT DISTINCT symbol FROM signals ORDER BY symbol
    `);

    if (symbolResult.recordset.length === 0) {
      return res.json([]);
    }

    const symbols = symbolResult.recordset.map(s => s.symbol);

    // Get open positions per symbol
    const positionsResult = await pool.request().query(`
      SELECT DISTINCT symbol FROM positions WHERE status = 'OPEN'
    `);
    const openSymbols = new Set(positionsResult.recordset.map(p => p.symbol));

    // Get latest signal per symbol
    const latestSignalsResult = await pool.request().query(`
      SELECT symbol, action, price, received_at FROM signals
      WHERE (symbol, received_at) IN (
        SELECT symbol, MAX(received_at) FROM signals GROUP BY symbol
      )
      ORDER BY symbol
    `);
    const signalMap = Object.fromEntries(latestSignalsResult.recordset.map(s => [s.symbol, s]));

    // Map symbols to Yahoo Finance format
    const yahooSymbols = symbols.map(s => {
      if (/USDT$/.test(s)) {
        return s.replace('USDT', '-USD');
      }
      return s;
    });

    // Fetch live quotes from Yahoo Finance
    let quotes = {};
    if (yahooFinance) {
      try {
        const queryOptions = { lang: 'en' };
        for (const ySymbol of yahooSymbols) {
          try {
            const quote = await yahooFinance.quote(ySymbol, {}, queryOptions);
            quotes[ySymbol] = quote;
          } catch (err) {
            console.warn(`[YAHOO] Failed to fetch ${ySymbol}:`, err.message);
            quotes[ySymbol] = null;
          }
        }
      } catch (err) {
        console.error('[YAHOO] Quote batch failed:', err.message);
      }
    } else {
      console.warn('[YAHOO] Module not loaded, returning empty quotes');
    }

    // Fetch Finnhub quotes in parallel
    const finnhubQuotes = {};
    if (finnhub.isConfigured()) {
      for (const symbol of symbols) {
        try {
          const quote = await finnhub.getQuote(symbol);
          finnhubQuotes[symbol] = quote;
        } catch (err) {
          console.warn(`[FINNHUB] Failed to fetch ${symbol}:`, err.message);
          finnhubQuotes[symbol] = null;
        }
      }
    }

    // Build response
    const result = symbols.map(symbol => {
      const ySymbol = yahooSymbols[symbols.indexOf(symbol)];
      const quote = quotes[ySymbol];
      const signal = signalMap[symbol];
      const finnhubQuote = finnhubQuotes[symbol];

      return {
        symbol,
        yahooSymbol: ySymbol,
        yahoo: quote ? {
          price: quote.regularMarketPrice || null,
          change: quote.regularMarketChange || null,
          changePercent: quote.regularMarketChangePercent || null,
          currency: quote.currency || 'USD',
          exchange: quote.exchange || null,
        } : null,
        finnhub: finnhubQuote || null,
        lastSignal: signal ? { action: signal.action, price: signal.price, time: signal.received_at } : null,
        hasOpenPosition: openSymbols.has(symbol),
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[SYMBOLS API]', err);
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

// Finnhub status endpoint
app.get('/api/finnhub/status', (req, res) => {
  res.json(finnhub.getStatus());
});

// Ticker lookup endpoint
app.get('/api/lookup-ticker', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol || symbol.trim().length === 0) {
      return res.status(400).json({ error: 'Symbol required' });
    }

    const result = await finnhub.searchSymbol(symbol);
    if (!result) {
      return res.json(null);
    }

    res.json({
      symbol: result.symbol,
      name: result.name,
      exchange: result.exchange,
      isCrypto: result.type === 'CRYPTO' || result.symbol?.includes('USDT'),
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

  // Strategy researcher cron (loaded after server starts)
  const { startCron } = require('./strategyResearcher');
  startCron();

  app.listen(config.port, () => {
    console.log(`TradingView x Claude running on port ${config.port}`);
    console.log(`Dashboard: http://localhost:${config.port}`);
    console.log(`Webhook:   POST http://localhost:${config.port}/webhook`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
