const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env.server' });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ 
    connectionString,
    ssl: { rejectUnauthorized: false }
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log('--- STARTING CUSTOMER BACKFILL ---');

  try {
    // 1. Find all CUSTOMER profiles
    const customerProfiles = await prisma.profile.findMany({
      where: { role: 'CUSTOMER' },
      include: { customer: true }
    });

    console.log(`Found ${customerProfiles.length} customer profiles.`);

    let createdCount = 0;
    for (const profile of customerProfiles) {
      if (!profile.customer) {
        console.log(`Fixing orphaned profile: ${profile.phoneNumber} (${profile.id})`);
        
        await prisma.customer.create({
          data: {
            profileId: profile.id,
            phone: profile.phoneNumber,
            fullName: 'Customer'
          }
        });
        createdCount++;
      }
    }

    console.log(`Successfully backfilled ${createdCount} customer records.`);
  } catch (error) {
    console.error('CRITICAL ERROR DURING BACKFILL:', error);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
