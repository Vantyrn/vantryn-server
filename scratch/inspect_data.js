const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const vendors = await prisma.vendor.findMany();
  console.log('VENDORS:', JSON.stringify(vendors, null, 2));

  const products = await prisma.product.findMany();
  console.log('PRODUCTS:', JSON.stringify(products, null, 2));

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
