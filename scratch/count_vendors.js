const { prisma } = require('../lib/prisma');

async function countAllVendors() {
  try {
    const result = await prisma.$queryRaw`
      SELECT table_schema, count(*) 
      FROM information_schema.tables 
      WHERE table_name = 'vendors'
      GROUP BY table_schema;
    `;
    console.log('Vendor tables found:');
    console.table(result);
    
    // Count rows in each
    for (const r of result) {
      const count = await prisma.$queryRawUnsafe(`SELECT count(*) FROM "${r.table_schema}"."vendors"`);
      console.log(`Rows in ${r.table_schema}.vendors:`, count);
    }
  } catch (error) {
    console.error('Error counting vendors:', error);
  } finally {
    await prisma.$disconnect();
  }
}

countAllVendors();
