const { prisma } = require('./lib/prisma');

async function seedCategories() {
  const categories = [
    { name: 'Biryani', description: 'Aromatic, flavorful layered rice dishes with rich Indian spices' },
    { name: 'Pizza', description: 'Freshly baked pizzas with a variety of crusts and delicious toppings' },
    { name: 'Burgers', description: 'Gourmet burgers, classic cheeseburgers, and crispy veggie options' },
    { name: 'South Indian', description: 'Authentic Dosa, Idli, Vada, Uttapam, and traditional sambar' },
    { name: 'North Indian', description: 'Flavorful curries, Dal Makhani, Paneer, Naan, and Tandoori dishes' },
    { name: 'Chinese', description: 'Indo-Chinese classics like Fried Rice, Noodles, Manchurian, and Chilli Paneer' },
    { name: 'Street Food', description: 'Indian chaat, Panipuri, Samosa, Pav Bhaji, and street treats' },
    { name: 'Fast Food', description: 'Quick bites including french fries, nuggets, wraps, and snacks' },
    { name: 'Desserts', description: 'Delicious sweets, traditional Indian mithai, cakes, and treats' },
    { name: 'Ice Cream', description: 'Assorted flavors of creamy ice cream, kulfi, and sundaes' },
    { name: 'Bakery', description: 'Freshly baked breads, pastries, cookies, and savory baked goods' },
    { name: 'Beverages', description: 'Refreshing milkshakes, mocktails, soft drinks, and cold beverages' },
    { name: 'Juice Center', description: 'Freshly squeezed fruit juices, fruit salads, and healthy smoothies' },
    { name: 'Tea & Coffee', description: 'Hot brewed cutting chai, filter coffee, cappuccino, and green teas' },
    { name: 'Shawarma', description: 'Spiced chicken or paneer shawarma wraps with rich garlic mayo' },
    { name: 'Rolls', description: 'Delicious Kathi rolls, egg rolls, spring rolls, and frankies' },
    { name: 'Sandwiches', description: 'Grilled sandwiches, Bombay style toast, club sandwiches, and paninis' },
    { name: 'Healthy Food', description: 'Salads, high-protein bowls, keto-friendly options, and light meals' },
    { name: 'Pure Veg', description: 'Specialized 100% vegetarian culinary delights' },
    { name: 'Non Veg', description: 'Succulent meat, poultry, and seafood delicacies' }
  ];

  console.log('🌱 Seeding Global Categories...');

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { name: cat.name },
      update: { 
        description: cat.description,
        vendorId: null 
      },
      create: {
        name: cat.name,
        description: cat.description,
        vendorId: null // Global category
      }
    });
  }

  console.log('✅ Categories Restored!');
}

seedCategories()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());

