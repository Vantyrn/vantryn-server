const { Pool } = require('pg');
require('dotenv').config({ path: '../.env.server' });

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ 
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  console.log('--- STARTING SCHEMA MIGRATION ---');

  try {
    const tablesToMove = ['customers', 'addresses', 'orders', 'feedbacks', 'carts', 'cart_items', 'guest_sessions'];

    for (const table of tablesToMove) {
      console.log(`Checking table: ${table}...`);
      
      // 1. Check if source table has data
      const countRes = await pool.query(`SELECT COUNT(*) FROM "vendor_delivery"."${table}"`);
      const count = parseInt(countRes.rows[0].count);

      if (count > 0) {
        console.log(`  Found ${count} rows in vendor_delivery.${table}. Moving to customer schema...`);
        
        // 2. Perform the move (Insert into destination, then delete from source)
        // Note: Using 'INSERT INTO ... SELECT *' works if schemas are identical
        try {
          await pool.query(`INSERT INTO "customer"."${table}" SELECT * FROM "vendor_delivery"."${table}" ON CONFLICT DO NOTHING`);
          console.log(`  SUCCESS: Data merged into customer.${table}`);
          
          // Optionally delete from old to avoid confusion
          // await pool.query(`DELETE FROM "vendor_delivery"."${table}"`);
        } catch (e) {
          console.log(`  WARNING: Could not move ${table}: ${e.message}`);
        }
      } else {
        console.log(`  No data to move for ${table}.`);
      }
    }

    console.log('\n--- MIGRATION COMPLETE ---');
    console.log('You can now safely delete the duplicate tables in the vendor_delivery schema via Neon console if you wish.');

  } catch (error) {
    console.error('MIGRATION FAILED:', error.message);
  } finally {
    await pool.end();
  }
}

migrate();
