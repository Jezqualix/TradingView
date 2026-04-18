const config = require('./config');

const BASE = 'https://finnhub.io/api/v1';

function toFinnhubSymbol(symbol) {
  // Crypto: BTCUSDT → BINANCE:BTCUSDT
  if (/USDT$/.test(symbol)) {
    const basePair = symbol.replace('USDT', '');
    return `BINANCE:${basePair}USDT`;
  }
  // Stocks: AAPL → AAPL (unchanged)
  return symbol;
}

async function getQuote(symbol) {
  if (!isConfigured()) {
    return null;
  }

  try {
    const finnhubSymbol = toFinnhubSymbol(symbol);
    const url = `${BASE}/quote?symbol=${finnhubSymbol}&token=${config.finnhub.apiKey}`;

    const fetch = typeof global.fetch === 'function'
      ? global.fetch
      : (() => {
          try {
            return require('node-fetch');
          } catch {
            return null;
          }
        })();

    if (!fetch) {
      console.warn('[FINNHUB] fetch not available');
      return null;
    }

    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) {
      console.warn(`[FINNHUB] HTTP ${res.status} for ${finnhubSymbol}`);
      return null;
    }

    const data = await res.json();

    // Finnhub field mapping:
    // c = current price
    // d = change (absolute)
    // dp = change percent
    if (data.c == null) {
      console.warn(`[FINNHUB] No price for ${finnhubSymbol}`);
      return null;
    }

    return {
      price: parseFloat(data.c),
      change: data.d ? parseFloat(data.d) : null,
      changePercent: data.dp ? parseFloat(data.dp) : null,
      source: 'Finnhub',
    };
  } catch (err) {
    console.warn(`[FINNHUB] Error for ${symbol}:`, err.message);
    return null;
  }
}

async function searchSymbol(query) {
  if (!isConfigured()) {
    return null;
  }

  try {
    const url = `${BASE}/search?q=${encodeURIComponent(query)}&token=${config.finnhub.apiKey}`;

    const fetch = typeof global.fetch === 'function'
      ? global.fetch
      : (() => {
          try {
            return require('node-fetch');
          } catch {
            return null;
          }
        })();

    if (!fetch) {
      console.warn('[FINNHUB] fetch not available');
      return null;
    }

    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) {
      console.warn(`[FINNHUB] Search HTTP ${res.status} for ${query}`);
      return null;
    }

    const data = await res.json();
    if (!data.result || data.result.length === 0) {
      return null;
    }

    // Return first result with description and type
    const result = data.result[0];
    return {
      symbol: result.symbol,
      name: result.description || result.symbol,
      exchange: result.mic || null,
      type: result.type || null,
    };
  } catch (err) {
    console.warn(`[FINNHUB] Search error for ${query}:`, err.message);
    return null;
  }
}

function isConfigured() {
  return !!config.finnhub.apiKey;
}

function getStatus() {
  return {
    configured: isConfigured(),
  };
}

module.exports = {
  getQuote,
  searchSymbol,
  isConfigured,
  getStatus,
};
