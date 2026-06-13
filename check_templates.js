const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const templates = await prisma.productTemplate.findMany();
    console.log('Templates found:', templates.length);
    console.log('Sample Template:', templates[0]?.templateName || 'NONE');
  } catch (err) {
    console.error('Check Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
