const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function patch() {
  try {
    const burger = await prisma.product.findFirst({
      where: { name: 'Maharaja Veg Burger' }
    });

    if (!burger) {
      console.error('Maharaja Veg Burger not found');
      return;
    }

    console.log(`Patching product ${burger.id}...`);

    // Clear existing customizations
    await prisma.customizationGroup.deleteMany({
      where: { productId: burger.id }
    });

    // Update product to be BYO
    await prisma.product.update({
      where: { id: burger.id },
      data: {
        isCustomizable: true,
        customizationType: 'BUILD_YOUR_OWN'
      }
    });

    // Add new groups
    await prisma.customizationGroup.create({
      data: {
        productId: burger.id,
        name: 'Choose Your Bun',
        isRequired: true,
        selectionType: 'SINGLE',
        displayOrder: 0,
        options: {
          create: [
            { name: 'Sesame Bun', priceModifier: 0, displayOrder: 0 },
            { name: 'Multigrain Bun', priceModifier: 20, displayOrder: 1 },
            { name: 'Gluten-Free Bun', priceModifier: 45, displayOrder: 2 }
          ]
        }
      }
    });

    await prisma.customizationGroup.create({
      data: {
        productId: burger.id,
        name: 'Add Extra Toppings',
        isRequired: false,
        selectionType: 'MULTIPLE',
        maxSelections: 5,
        displayOrder: 1,
        options: {
          create: [
            { name: 'Extra Cheese Slice', priceModifier: 30, displayOrder: 0 },
            { name: 'Jalapenos', priceModifier: 15, displayOrder: 1 },
            { name: 'Caramelized Onions', priceModifier: 25, displayOrder: 2 },
            { name: 'Grilled Mushrooms', priceModifier: 40, displayOrder: 3 }
          ]
        }
      }
    });

    await prisma.customizationGroup.create({
      data: {
        productId: burger.id,
        name: 'Choose Your Sauce',
        isRequired: true,
        selectionType: 'SINGLE',
        displayOrder: 2,
        options: {
          create: [
            { name: 'Classic Mayo', priceModifier: 0, displayOrder: 0 },
            { name: 'Spicy Sriracha', priceModifier: 10, displayOrder: 1 },
            { name: 'Smoky BBQ', priceModifier: 15, displayOrder: 2 },
            { name: 'Tandoori Zest', priceModifier: 15, displayOrder: 3 }
          ]
        }
      }
    });

    console.log('Successfully patched Maharaja Veg Burger with customizations!');
  } catch (error) {
    console.error('Patch failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

patch();
