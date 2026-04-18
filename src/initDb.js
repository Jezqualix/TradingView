const fs = require('fs');
const path = require('path');
const { getDb, sql } = require('./db');
const config = require('./config');

async function initDatabase() {
  console.log('Connecting to MSSQL...');
  const pool = await getDb();

  console.log('Running schema.sql...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // Split on GO-style batches (each IF NOT EXISTS block)
  const statements = schema
    .split(/^(?=IF NOT EXISTS)/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    await pool.request().query(stmt);
  }
  console.log('All tables created.');

  // Insert initial portfolio row if none exists
  const existing = await pool.request().query('SELECT COUNT(*) AS cnt FROM portfolio');
  if (existing.recordset[0].cnt === 0) {
    const balance = config.trading.startingBalance;
    await pool.request()
      .input('starting', sql.Decimal(18, 2), balance)
      .input('current', sql.Decimal(18, 2), balance)
      .query('INSERT INTO portfolio (starting_balance, current_balance) VALUES (@starting, @current)');
    console.log(`Portfolio initialized with balance: $${balance}`);
  } else {
    console.log('Portfolio already exists, skipping init.');
  }

  console.log('Database initialization complete.');
  process.exit(0);
}

initDatabase().catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
