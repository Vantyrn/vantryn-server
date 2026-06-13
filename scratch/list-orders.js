const { prisma } = require('../lib/prisma');
async function main() {
  const orders = await prisma.order.findMany({
    where: { vendorId: '331746cc-4a5a-4de9-9f86-e4a62fee2b42' },
    select: { id: true, status: true }
  });
  console.log(JSON.stringify(orders, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
