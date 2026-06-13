const { prisma } = require('./lib/prisma');

async function check() {
  const vendors = await prisma.vendor.findMany({
    select: {
      id: true,
      businessName: true,
      onlineStatus: true,
      operatingHours: true
    }
  });
  console.log(JSON.stringify(vendors, null, 2));
  process.exit(0);
}

check();
