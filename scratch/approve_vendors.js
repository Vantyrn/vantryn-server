const { prisma } = require('../lib/prisma');

async function approveAllVendors() {
  try {
    const result = await prisma.vendor.updateMany({
      data: {
        accountStatus: 'APPROVED'
      }
    });
    console.log(`Successfully approved ${result.count} vendors.`);
    
    // Also update profiles for consistency
    const vendors = await prisma.vendor.findMany({ select: { profileId: true } });
    for (const vendor of vendors) {
      if (vendor.profileId) {
        await prisma.profile.update({
          where: { id: vendor.profileId },
          data: { profileStatus: 'APPROVED' }
        });
      }
    }
    console.log('Profile statuses synchronized.');
    
  } catch (error) {
    console.error('Error approving vendors:', error);
  } finally {
    await prisma.$disconnect();
  }
}

approveAllVendors();
