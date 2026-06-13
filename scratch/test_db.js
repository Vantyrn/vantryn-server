const { Pool } = require('pg');
require('dotenv').config({ path: '../.env.server' });

const connectionString = process.env.DATABASE_URL;
console.log('Testing connection to:', connectionString.replace(/:[^:]+@/, ':****@'));

const pool = new Pool({ 
  connectionString,
  ssl: {
    rejectUnauthorized: false // Common for Neon and other cloud DBs
  }
});

pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'vendor_delivery';", (err, res) => {
  if (err) {
    console.error('Query failed:', err.message);
  } else {
    console.log('Schemas found:', res.rows);
  }
  pool.end();
});
