const sql = require('mssql');
const config = require('./config');

const dbConfig = {
  server: config.db.server,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

let pool = null;

async function getDb() {
  if (pool) return pool;
  pool = await sql.connect(dbConfig);
  return pool;
}

module.exports = { getDb, sql };
