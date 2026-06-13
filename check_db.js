const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const products = await prisma.product.findMany({
      where: { 
        isCustomizable: true 
      },
      include: {
        customizationGroups: {
          include: { options: true }
        }
      }
    });

    console.log(`Found ${products.length} customizable products.`);
    products.forEach(p => {
      console.log(`- ${p.name} (ID: ${p.id}, Type: ${p.customizationType}, Groups: ${p.customizationGroups.length})`);
      p.customizationGroups.forEach(g => {
        console.log(`  * Group: ${g.name} (${g.options.length} options)`);
      });
    });
  } catch (error) {
    console.error('Check failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

check();
