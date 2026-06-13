const { Pool } = require('pg');
require('dotenv').config({ path: '../.env.server' });

async function introspect() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ 
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  const tables = ['customers', 'addresses', 'orders'];
  
  try {
    for (const table of tables) {
      console.log(`\n--- TABLE: ${table} ---`);
      
      const query = `
        SELECT schema_name, column_name, data_type, is_nullable
        FROM (
          SELECT 'vendor_delivery' as schema_name, column_name, data_type, is_nullable
          FROM information_schema.columns 
          WHERE table_schema = 'vendor_delivery' AND table_name = $1
          UNION ALL
          SELECT 'customer' as schema_name, column_name, data_type, is_nullable
          FROM information_schema.columns 
          WHERE table_schema = 'customer' AND table_name = $1
        ) t
        ORDER BY column_name, schema_name
      `;
      
      const res = await pool.query(query, [table]);
      console.table(res.rows);
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

introspect();
