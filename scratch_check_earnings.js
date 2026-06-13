const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ 
  connectionString,
  ssl: { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function testEarningsQuery() {
  try {
    console.log('[AUDIT] Fetching all VENDOR profiles...');
    const profiles = await prisma.profile.findMany({
      where: { role: 'VENDOR' },
      include: { vendor: true }
    });

    console.log(`[AUDIT] Found ${profiles.length} vendor profiles.`);

    for (const p of profiles) {
      console.log(`\n-------------------------------------`);
      console.log(`[VENDOR PROFILE] UID: ${p.firebaseUid}, status: ${p.profileStatus}`);
      if (!p.vendor) {
        console.warn(`[WARNING] Profile has NO associated vendor record!`);
        continue;
      }
      console.log(`[VENDOR RECORD] ID: ${p.vendor.id}, Business Name: ${p.vendor.businessName}`);

      try {
        console.log(`[QUERY] Running vendorEarning aggregate query...`);
        const earnings = await prisma.vendorEarning.aggregate({
          _sum: { orderTotal: true, commissionAmt: true, vendorPayout: true },
          _count: { orderId: true },
          where: { vendorId: p.vendor.id }
        });
        console.log(`[QUERY SUCCESS] aggregate results:`, JSON.stringify(earnings, null, 2));

        console.log(`[QUERY] Running vendorEarning findMany query...`);
        const earningsList = await prisma.vendorEarning.findMany({
          where: { vendorId: p.vendor.id },
          orderBy: { earnedAt: 'asc' },
          take: 30
        });
        console.log(`[QUERY SUCCESS] findMany count: ${earningsList.length}`);

        // Simple grouping logic mimicking backend
        const groupedData = {};
        earningsList.forEach(e => {
          const date = e.earnedAt.toISOString().split('T')[0];
          if (!groupedData[date]) {
            groupedData[date] = { gross: 0, net: 0, count: 0 };
          }
          groupedData[date].gross += Number(e.orderTotal);
          groupedData[date].net += Number(e.vendorPayout);
          groupedData[date].count += 1;
        });
        console.log(`[LOGIC] Grouped data dates count: ${Object.keys(groupedData).length}`);

      } catch (err) {
        console.error(`[CRITICAL ERROR] Query failed for vendor ${p.vendor.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[AUDIT FAILED] Global error in audit script:', err);
  } finally {
    await prisma.$disconnect();
  }
}

testEarningsQuery();
