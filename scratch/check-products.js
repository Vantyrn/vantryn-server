const { prisma } = require('../lib/prisma');

async function main() {
  const products = await prisma.product.findMany({
    include: { images: true }
  });

  console.log('--- PRODUCTS LIST ---');
  console.log(JSON.stringify(products, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
