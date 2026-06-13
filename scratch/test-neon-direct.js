require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('@neondatabase/serverless');
const ws = require('ws');

async function testNeon() {
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
  }

  console.log('Testing URL:', connectionString);

  try {
    const pool = new Pool({ connectionString, webSocketConstructor: ws });
    const client = await pool.connect();
    console.log('SUCCESS: Connected to Neon!');
    const res = await client.query('SELECT NOW()');
    console.log('Server time:', res.rows[0]);
    await client.release();
    await pool.end();
  } catch (err) {
    console.error('NEON ERROR:', err);
  }
}

testNeon();
