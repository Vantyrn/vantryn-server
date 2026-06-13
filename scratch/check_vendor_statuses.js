const { prisma } = require('../lib/prisma');

async function main() {
  const vendors = await prisma.vendor.findMany({
    select: {
      id: true,
      businessName: true,
      onlineStatus: true,
      accountStatus: true
    }
  });

  console.log('--- Vendor Status Report ---');
  vendors.forEach(v => {
    console.log(`[${v.id}] ${v.businessName}: onlineStatus=${v.onlineStatus}, accountStatus=${v.accountStatus}`);
  });
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
