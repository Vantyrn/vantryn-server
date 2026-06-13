require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function debugProfiles() {
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
  }

  const pool = new Pool({ connectionString, ssl: true });
  try {
    const client = await pool.connect();
    
    console.log('--- TEST USER PROFILE ---');
    const profileResult = await client.query("SELECT * FROM vendor_delivery.profiles WHERE phone_number = '+919999999999'");
    console.log(profileResult.rows[0]);
    
    client.release();
  } catch (err) {
    console.error('ERROR:', err);
  } finally {
    await pool.end();
  }
}

debugProfiles();
