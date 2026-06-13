const { prisma } = require('../lib/prisma');

async function approveAllVendorsRaw() {
  try {
    // Attempt both camelCase and snake_case just in case
    try {
      await prisma.$executeRawUnsafe(`
        UPDATE "vendor_delivery"."vendors" 
        SET "account_status" = 'APPROVED'
      `);
      console.log('Successfully approved vendors using snake_case.');
    } catch (e1) {
      console.warn('Snake case update failed, trying camelCase...');
      await prisma.$executeRawUnsafe(`
        UPDATE "vendor_delivery"."vendors" 
        SET "accountStatus" = 'APPROVED'
      `);
      console.log('Successfully approved vendors using camelCase.');
    }

    // Also update profiles
    await prisma.$executeRawUnsafe(`
      UPDATE "customer"."profiles" 
      SET "profile_status" = 'APPROVED' 
      WHERE "role" = 'VENDOR'
    `);
    console.log('Profile statuses synchronized.');

  } catch (error) {
    console.error('Error in raw approval:', error);
  } finally {
    await prisma.$disconnect();
  }
}

approveAllVendorsRaw();
