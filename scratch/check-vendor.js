const { prisma } = require('../lib/prisma');
async function main() {
  const vendor = await prisma.vendor.findUnique({
    where: { id: '331746cc-4a5a-4de9-9f86-e4a62fee2b42' }
  });
  console.log(JSON.stringify(vendor, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
