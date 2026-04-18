const cron = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb, sql } = require('./db');
const config = require('./config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const SEARCH_QUERIES = [
  { query: 'profitable crypto trading strategies 2026 backtested', assetType: 'CRYPTO' },
  { query: 'RSI MACD combination swing trading stocks backtest results', assetType: 'STOCK' },
  { query: 'TradingView Pine Script strategy with verified win rate', assetType: 'CRYPTO' },
  { query: 'best stock day trading strategies backtested data', assetType: 'STOCK' },
];

async function researchStrategies() {
  console.log('[RESEARCH] Starting weekly strategy research...');

  for (const { query, assetType } of SEARCH_QUERIES) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{
          role: 'user',
          content: `Search for: "${query}"

Find trading strategies and evaluate them. For each strategy found, provide a JSON array of objects with this structure:
{
  "name": "strategy name",
  "description": "brief description of how it works",
  "indicators": "comma-separated list of indicators used",
  "asset_type": "${assetType}",
  "claimed_win_rate": number or null,
  "skepticism_score": 0-100 (0 = anonymous blog, 50 = popular community backtest, 85+ = peer-reviewed or independently verified),
  "source_url": "url where you found it"
}

Be highly skeptical. Most claimed win rates are exaggerated. Respond with ONLY the JSON array.`,
        }],
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      let strategies;
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        strategies = JSON.parse(jsonMatch[0]);
      } catch {
        console.error(`[RESEARCH] Failed to parse response for: ${query}`);
        continue;
      }

      const pool = await getDb();
      for (const s of strategies) {
        // Upsert by name + asset_type
        const existing = await pool.request()
          .input('name', sql.VarChar(100), s.name)
          .input('assetType', sql.VarChar(10), s.asset_type || assetType)
          .query('SELECT id FROM strategies WHERE name = @name AND asset_type = @assetType');

        if (existing.recordset.length > 0) {
          await pool.request()
            .input('id', sql.BigInt, existing.recordset[0].id)
            .input('description', sql.NVarChar(sql.MAX), s.description)
            .input('indicators', sql.NVarChar(500), s.indicators)
            .input('claimedWinRate', sql.Decimal(5, 2), s.claimed_win_rate)
            .input('skepticismScore', sql.TinyInt, s.skepticism_score)
            .input('sourceUrl', sql.NVarChar(500), s.source_url)
            .query(`
              UPDATE strategies
              SET description = @description, indicators = @indicators,
                  claimed_win_rate = @claimedWinRate, skepticism_score = @skepticismScore,
                  source_url = @sourceUrl, last_updated = GETDATE()
              WHERE id = @id
            `);
        } else {
          await pool.request()
            .input('name', sql.VarChar(100), s.name)
            .input('description', sql.NVarChar(sql.MAX), s.description)
            .input('indicators', sql.NVarChar(500), s.indicators)
            .input('assetType', sql.VarChar(10), s.asset_type || assetType)
            .input('claimedWinRate', sql.Decimal(5, 2), s.claimed_win_rate)
            .input('skepticismScore', sql.TinyInt, s.skepticism_score)
            .input('sourceUrl', sql.NVarChar(500), s.source_url)
            .query(`
              INSERT INTO strategies (name, description, indicators, asset_type, claimed_win_rate, skepticism_score, source_url)
              VALUES (@name, @description, @indicators, @assetType, @claimedWinRate, @skepticismScore, @sourceUrl)
            `);
        }
      }

      console.log(`[RESEARCH] Stored ${strategies.length} strategies for "${query}"`);
    } catch (err) {
      console.error(`[RESEARCH] Error for "${query}":`, err.message);
    }
  }

  console.log('[RESEARCH] Weekly research complete.');
}

function startCron() {
  // Run every Sunday at 3:00 AM
  cron.schedule('0 3 * * 0', () => {
    researchStrategies().catch(err => console.error('[RESEARCH CRON ERROR]', err));
  });
  console.log('Strategy researcher scheduled (Sundays 3:00 AM)');
}

module.exports = { startCron, researchStrategies };
