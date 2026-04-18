const config = require('./config');

const BASE = 'https://api.massive.com';

function _getFetch() {
  if (typeof global.fetch === 'function') return global.fetch;
  try { return require('node-fetch'); } catch { return null; }
}

async function _fetch(url, timeoutMs) {
  const fetch = _getFetch();
  if (!fetch) {
    console.warn('[MASSIVE] fetch not available');
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${config.massive.apiKey}` },
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupTicker(symbol) {
  if (!isConfigured()) return null;

  try {
    const url = `${BASE}/v3/reference/tickers/${encodeURIComponent(symbol.toUpperCase())}`;
    const res = await _fetch(url, 5000);
    if (!res) return null;

    if (!res.ok) {
      console.warn(`[MASSIVE] HTTP ${res.status} for ${symbol}`);
      return null;
    }

    const data = await res.json();
    if (!data.results) return null;

    const r = data.results;
    return {
      symbol: r.ticker,
      name: r.name || null,
      exchange: r.primary_exchange || null,
      type: r.type || null,
      market: r.market || null,
    };
  } catch (err) {
    console.warn(`[MASSIVE] Error for ${symbol}:`, err.message);
    return null;
  }
}

async function getSnapshot(symbol, assetType) {
  if (!isConfigured()) return null;
  if (assetType === 'CRYPTO') return null; // not available on current plan

  try {
    const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol.toUpperCase())}`;
    const res = await _fetch(url, 8000);
    if (!res) return null;

    if (!res.ok) {
      console.warn(`[MASSIVE] Snapshot HTTP ${res.status} for ${symbol}`);
      return null;
    }

    const data = await res.json();
    const t = data.ticker;
    if (!t) return null;

    return {
      price:      t.lastTrade?.p  ?? t.day?.c  ?? null,
      open:       t.day?.o  ?? null,
      high:       t.day?.h  ?? null,
      low:        t.day?.l  ?? null,
      prev_close: t.prevDay?.c ?? null,
      volume:     t.day?.v  ?? null,
      vwap:       t.day?.vw ?? null,
      change:     t.todaysChange     ?? null,
      change_pct: t.todaysChangePerc ?? null,
      bid:        t.lastQuote?.p ?? null,
      ask:        t.lastQuote?.P ?? null,
    };
  } catch (err) {
    console.warn(`[MASSIVE] Snapshot error for ${symbol}:`, err.message);
    return null;
  }
}

async function getExchanges(assetClass) {
  if (!isConfigured()) return [];

  try {
    const url = `${BASE}/v3/reference/exchanges?asset_class=${encodeURIComponent(assetClass)}`;
    const res = await _fetch(url, 8000);
    if (!res) return [];

    if (!res.ok) {
      console.warn(`[MASSIVE] Exchanges HTTP ${res.status} for ${assetClass}`);
      return [];
    }

    const data = await res.json();
    if (!data.results) return [];

    // Stocks: use MIC as value. Crypto: use name as value (no MIC codes).
    return data.results
      .filter(e => e.type === 'exchange')
      .map(e => ({
        value: assetClass === 'stocks' ? e.mic : e.name,
        label: assetClass === 'stocks' ? `${e.mic} — ${e.name}` : e.name,
      }));
  } catch (err) {
    console.warn(`[MASSIVE] Exchanges error for ${assetClass}:`, err.message);
    return [];
  }
}

function isConfigured() {
  return !!config.massive.apiKey;
}

module.exports = { lookupTicker, getSnapshot, getExchanges, isConfigured };
