const { prisma } = require('../lib/prisma');

async function debugProfiles() {
  try {
    const result = await prisma.$queryRaw`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'profiles' AND table_schema = 'vendor_delivery';
    `;
    console.log('Columns in vendor_delivery.profiles:');
    console.table(result);
  } catch (error) {
    console.error('Error debugging profiles:', error);
  } finally {
    await prisma.$disconnect();
  }
}

debugProfiles();
