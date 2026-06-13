require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function debugData() {
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
  }

  const pool = new Pool({ connectionString, ssl: true });
  try {
    const client = await pool.connect();
    
    console.log('--- LATEST VENDOR ---');
    const vendorResult = await client.query('SELECT * FROM vendor_delivery.vendors ORDER BY created_at DESC LIMIT 1');
    console.log(vendorResult.rows[0]);
    
    if (vendorResult.rows[0]) {
        console.log('--- BANK DETAILS ---');
        const bankResult = await client.query(`SELECT * FROM vendor_delivery.vendor_bank_details WHERE vendor_id = '${vendorResult.rows[0].id}'`);
        console.log(bankResult.rows[0]);
    }
    
    client.release();
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
}

debugData();
