const { prisma } = require('../lib/prisma');
async function main() {
  const vendors = await prisma.vendor.findMany({
    select: { id: true, businessName: true, phone: true }
  });
  console.log(JSON.stringify(vendors, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
