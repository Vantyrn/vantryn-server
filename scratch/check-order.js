const { prisma } = require('../lib/prisma');
async function main() {
  const order = await prisma.order.findUnique({
    where: { id: 'fe43b772-81c5-4ece-a5cb-074177bb2c51' },
    select: { id: true, vendorId: true, status: true }
  });
  console.log(JSON.stringify(order, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
