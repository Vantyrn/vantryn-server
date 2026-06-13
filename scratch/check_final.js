const { prisma } = require('../lib/prisma');

async function checkFinalStatus() {
  try {
    const result = await prisma.$queryRaw`
      SELECT "id", "businessName", "accountStatus" 
      FROM "vendor_delivery"."vendors";
    `;
    console.log('Final Vendor Status:');
    console.table(result);
  } catch (error) {
    console.error('Error checking final status:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkFinalStatus();
