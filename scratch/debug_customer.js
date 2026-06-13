const { prisma } = require('../lib/prisma');

async function debugCustomerSchema() {
  try {
    const result = await prisma.$queryRaw`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'customer';
    `;
    console.log('Tables in customer schema:');
    console.table(result);
  } catch (error) {
    console.error('Error debugging customer schema:', error);
  } finally {
    await prisma.$disconnect();
  }
}

debugCustomerSchema();
