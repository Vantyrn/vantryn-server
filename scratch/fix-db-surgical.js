require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function fixDatabase() {
  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
  }

  const pool = new Pool({ connectionString, ssl: true });
  try {
    const client = await pool.connect();
    
    console.log('Running surgical SQL fix...');
    
    const sql = `
      -- Create profiles table if it does not exist
      CREATE TABLE IF NOT EXISTS "vendor_delivery"."profiles" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "firebase_uid" TEXT NOT NULL,
        "phone_number" TEXT NOT NULL,
        "role" VARCHAR(20),
        "profile_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
      );

      -- Add unique indices
      CREATE UNIQUE INDEX IF NOT EXISTS "profiles_firebase_uid_key" ON "vendor_delivery"."profiles"("firebase_uid");
      CREATE UNIQUE INDEX IF NOT EXISTS "profiles_phone_number_key" ON "vendor_delivery"."profiles"("phone_number");

      -- Ensure existing tables have the profile_id column and indices
      ALTER TABLE "vendor_delivery"."vendors" ADD COLUMN IF NOT EXISTS "profile_id" UUID;
      ALTER TABLE "vendor_delivery"."vendors" DROP CONSTRAINT IF EXISTS "vendors_profile_id_fkey";
      ALTER TABLE "vendor_delivery"."vendors" ADD CONSTRAINT "vendors_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vendor_delivery"."profiles"("id");
      CREATE UNIQUE INDEX IF NOT EXISTS "vendors_profile_id_key" ON "vendor_delivery"."vendors"("profile_id");

      ALTER TABLE "vendor_delivery"."riders" ADD COLUMN IF NOT EXISTS "profile_id" UUID;
      ALTER TABLE "vendor_delivery"."riders" DROP CONSTRAINT IF EXISTS "riders_profile_id_fkey";
      ALTER TABLE "vendor_delivery"."riders" ADD CONSTRAINT "riders_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "vendor_delivery"."profiles"("id");
      CREATE UNIQUE INDEX IF NOT EXISTS "riders_profile_id_key" ON "vendor_delivery"."riders"("profile_id");
    `;

    await client.query(sql);
    console.log('SUCCESS: Profiles table created/verified!');
    
    client.release();
  } catch (err) {
    console.error('SQL FIX ERROR:', err);
  } finally {
    await pool.end();
  }
}

fixDatabase();
