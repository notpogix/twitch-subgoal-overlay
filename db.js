const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
} else {
  console.warn('DATABASE_URL not set; DB functions will fail locally.');
}

async function query(text, params) {
  if (!pool) {
    throw new Error('No database pool. Set DATABASE_URL to use DB.');
  }
  const res = await pool.query(text, params);
  return res;
}

module.exports = { query, pool };
