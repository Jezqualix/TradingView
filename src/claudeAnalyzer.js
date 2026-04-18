const Anthropic = require('@anthropic-ai/sdk');
const { getDb, sql } = require('./db');
const config = require('./config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SYSTEM_PROMPT = `You are a skeptical, risk-aware trading analyst evaluating signals for a paper portfolio.

Rules:
- Default to SKIP when uncertain. Missing a good trade is better than taking a bad one.
- Always weigh downside risk before upside potential.
- Treat claimed win rates from unverified sources with heavy skepticism.
- Never chase momentum — if the move has already happened, skip it.
- Flag unusual conditions (high volatility, news events, low-liquidity hours) as risk factors.
- After each decision, write 1-2 concise learnings to memory if applicable.`;

async function fetchContext(symbol) {
  const pool = await getDb();
  const assetType = /USDT|USDC|BTC|ETH/i.test(symbol) ? 'CRYPTO' : 'STOCK';

  const [signals, decisions, positions, portfolio, strategies, memory] = await Promise.all([
    pool.request()
      .input('symbol', sql.VarChar(20), symbol)
      .input('limit', sql.Int, config.trading.signalHistory)
      .query('SELECT TOP (@limit) * FROM signals WHERE symbol = @symbol ORDER BY received_at DESC'),

    pool.request()
      .input('symbol', sql.VarChar(20), symbol)
      .input('limit', sql.Int, config.trading.decisionHistory)
      .query(`
        SELECT TOP (@limit) d.*, p.pnl_usd, p.status AS position_status
        FROM decisions d
        LEFT JOIN positions p ON p.decision_id = d.id
        WHERE d.signal_id IN (SELECT id FROM signals WHERE symbol = @symbol)
        ORDER BY d.decided_at DESC
      `),

    pool.request()
      .query("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at DESC"),

    pool.request()
      .query('SELECT TOP 1 * FROM portfolio ORDER BY id DESC'),

    pool.request()
      .input('assetType', sql.VarChar(10), assetType)
      .query('SELECT TOP 5 * FROM strategies WHERE asset_type = @assetType ORDER BY skepticism_score DESC'),

    pool.request()
      .input('symbol', sql.VarChar(20), symbol)
      .input('assetType', sql.VarChar(10), assetType)
      .query(`
        SELECT TOP 20 * FROM claude_memory
        WHERE symbol = @symbol OR symbol IS NULL OR asset_type = @assetType
        ORDER BY created_at DESC
      `),
  ]);

  return {
    recentSignals: signals.recordset.reverse(),
    pastDecisions: decisions.recordset.reverse(),
    openPositions: positions.recordset,
    portfolio: portfolio.recordset[0] || null,
    strategies: strategies.recordset,
    memory: memory.recordset,
    assetType,
  };
}

function buildUserPrompt(signal, context) {
  const parts = [
    `CURRENT SIGNAL: ${JSON.stringify({ symbol: signal.symbol, action: signal.action, price: signal.price, interval: signal.interval, rsi: signal.rsi, macd: signal.macd, ema_fast: signal.ema_fast, ema_slow: signal.ema_slow })}`,
    `\nRECENT SIGNALS (last ${context.recentSignals.length} for ${signal.symbol}):\n${JSON.stringify(context.recentSignals.map(s => ({ action: s.action, price: s.price, rsi: s.rsi, macd: s.macd, time: s.received_at })), null, 2)}`,
    `\nPAST DECISIONS (last ${context.pastDecisions.length} for ${signal.symbol}):\n${JSON.stringify(context.pastDecisions.map(d => ({ decision: d.decision, confidence: d.confidence, reasoning: d.reasoning, pnl: d.pnl_usd, time: d.decided_at })), null, 2)}`,
    `\nOPEN POSITIONS:\n${JSON.stringify(context.openPositions.map(p => ({ symbol: p.symbol, side: p.side, amount_usd: p.amount_usd, entry_price: p.entry_price, opened_at: p.opened_at })), null, 2)}`,
  ];

  if (context.portfolio) {
    const p = context.portfolio;
    const winRate = p.total_trades > 0 ? ((p.winning_trades / p.total_trades) * 100).toFixed(1) : '0.0';
    parts.push(`\nPORTFOLIO: ${JSON.stringify({ balance: p.current_balance, starting_balance: p.starting_balance, total_trades: p.total_trades, win_rate: winRate + '%' })}`);
  }

  if (context.strategies.length > 0) {
    parts.push(`\nSTRATEGY LIBRARY:\n${JSON.stringify(context.strategies.map(s => ({ name: s.name, description: s.description, indicators: s.indicators, skepticism_score: s.skepticism_score })), null, 2)}`);
  }

  if (context.memory.length > 0) {
    parts.push(`\nCLAUDE MEMORY:\n${JSON.stringify(context.memory.map(m => ({ insight: m.insight, symbol: m.symbol, source: m.source, created: m.created_at })), null, 2)}`);
  }

  parts.push(`\nRespond ONLY in this JSON format:
{
  "decision":         "TRADE" | "SKIP",
  "confidence":       0-100,
  "reasoning":        "...",
  "risk_notes":       "...",
  "matched_strategy": "strategy name or null",
  "memory_update":    "concise insight to save, or null"
}`);

  return parts.join('\n');
}

async function analyze(signal) {
  const context = await fetchContext(signal.symbol);
  const userPrompt = buildUserPrompt(signal, context);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;
  const tokensUsed = (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0);

  // Parse JSON from response (handle markdown code blocks)
  let parsed;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = { decision: 'SKIP', confidence: 0, reasoning: 'Failed to parse Claude response: ' + text, risk_notes: 'Parse error', matched_strategy: null, memory_update: null };
  }

  // Store decision
  const pool = await getDb();
  const decisionResult = await pool.request()
    .input('signalId', sql.BigInt, signal.signalId)
    .input('decision', sql.VarChar(10), parsed.decision)
    .input('confidence', sql.TinyInt, Math.min(100, Math.max(0, parsed.confidence)))
    .input('reasoning', sql.NVarChar(sql.MAX), parsed.reasoning)
    .input('riskNotes', sql.NVarChar(sql.MAX), parsed.risk_notes)
    .input('matchedStrategy', sql.VarChar(100), parsed.matched_strategy || null)
    .input('tokensUsed', sql.Int, tokensUsed)
    .query(`
      INSERT INTO decisions (signal_id, decision, confidence, reasoning, risk_notes, matched_strategy, tokens_used)
      OUTPUT INSERTED.id
      VALUES (@signalId, @decision, @confidence, @reasoning, @riskNotes, @matchedStrategy, @tokensUsed)
    `);

  const decisionId = decisionResult.recordset[0].id;

  // Store memory update if provided
  if (parsed.memory_update) {
    await pool.request()
      .input('symbol', sql.VarChar(20), signal.symbol)
      .input('assetType', sql.VarChar(10), context.assetType)
      .input('insight', sql.NVarChar(sql.MAX), parsed.memory_update)
      .input('source', sql.VarChar(20), 'TRADE')
      .input('confidence', sql.TinyInt, parsed.confidence)
      .query('INSERT INTO claude_memory (symbol, asset_type, insight, source, confidence) VALUES (@symbol, @assetType, @insight, @source, @confidence)');
  }

  return {
    decisionId,
    decision: parsed.decision,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    riskNotes: parsed.risk_notes,
    matchedStrategy: parsed.matched_strategy,
    memoryUpdate: parsed.memory_update,
    tokensUsed,
  };
}

module.exports = { analyze };
