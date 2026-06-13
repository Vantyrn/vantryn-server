const { Pool } = require('pg');
require('dotenv').config({ path: '../.env.server' });

async function diagnose() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ 
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  console.log('--- DATABASE DIAGNOSTICS ---');
  console.log('Target:', connectionString.split('@')[1]);

  try {
    const schemas = ['customer', 'vendor_delivery'];
    
    for (const schema of schemas) {
      console.log(`\n[Schema: ${schema}]`);
      
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = $1
      `;
      const tablesRes = await pool.query(tablesQuery, [schema]);
      
      if (tablesRes.rows.length === 0) {
        console.log('  No tables found.');
        continue;
      }

      for (const row of tablesRes.rows) {
        const tableName = row.table_name;
        try {
          const countRes = await pool.query(`SELECT COUNT(*) FROM "${schema}"."${tableName}"`);
          console.log(`  Table: ${tableName.padEnd(25)} | Rows: ${countRes.rows[0].count}`);
        } catch (e) {
          console.log(`  Table: ${tableName.padEnd(25)} | Error: ${e.message}`);
        }
      }
    }

  } catch (error) {
    console.error('DIAGNOSTICS FAILED:', error.message);
  } finally {
    await pool.end();
  }
}

diagnose();
