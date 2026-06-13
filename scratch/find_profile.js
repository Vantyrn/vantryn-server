const { prisma } = require('../lib/prisma');

async function findProfileTable() {
  try {
    const result = await prisma.$queryRaw`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_name ILIKE '%profile%';
    `;
    console.log('Profile tables found:');
    console.table(result);
  } catch (error) {
    console.error('Error finding profile table:', error);
  } finally {
    await prisma.$disconnect();
  }
}

findProfileTable();
