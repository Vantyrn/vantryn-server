require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function checkTables() {
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
  }

  const pool = new Pool({ connectionString, ssl: true });
  try {
    const client = await pool.connect();
    
    console.log('--- SCHEMA LIST ---');
    const schemas = await client.query('SELECT schema_name FROM information_schema.schemata');
    console.log(schemas.rows.map(r => r.schema_name));

    console.log('--- TABLE LIST (vendor_delivery) ---');
    try {
      const tables = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'vendor_delivery'");
      console.log(tables.rows.map(r => r.table_name));
    } catch (e) {
      console.log('Error checking vendor_delivery schema:', e.message);
    }

    client.release();
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
}

checkTables();
