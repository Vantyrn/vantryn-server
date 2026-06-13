const { prisma } = require('../lib/prisma');

async function debugTable() {
  try {
    const result = await prisma.$queryRaw`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'vendors' AND table_schema = 'vendor_delivery';
    `;
    console.log('Columns in vendor_delivery.vendors:');
    console.table(result);
  } catch (error) {
    console.error('Error debugging table:', error);
  } finally {
    await prisma.$disconnect();
  }
}

debugTable();
