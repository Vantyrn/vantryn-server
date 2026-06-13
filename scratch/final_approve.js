const { prisma } = require('../lib/prisma');

async function finalApprove() {
  try {
    // 1. Approve Vendors (using camelCase based on debug output)
    await prisma.$executeRawUnsafe(`
      UPDATE "vendor_delivery"."vendors" 
      SET "accountStatus" = 'APPROVED'
    `);
    console.log('Vendors approved.');

    // 2. Sync Profiles (using vendor_delivery schema where it actually exists)
    await prisma.$executeRawUnsafe(`
      UPDATE "vendor_delivery"."profiles" 
      SET "profileStatus" = 'APPROVED' 
      WHERE "role" = 'VENDOR'
    `);
    console.log('Profiles approved.');

  } catch (error) {
    console.error('Final approval failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

finalApprove();
