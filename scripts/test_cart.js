const { prisma, getOrCreateCustomerProfile } = require('../lib/prisma');
const CartService = require('../services/cartService');

async function test() {
  console.log('--- CART DIAGNOSTIC ---');
  try {
    // 1. Mock user
    const mockUser = {
      uid: 'eyJh...', // This should be a real UID from your DB if possible
      phoneNumber: '1234567890',
      name: 'Diagnostic User'
    };

    console.log('Step 1: getOrCreateCustomerProfile...');
    // Finding a real user UID to test with (optional but better)
    const firstProfile = await prisma.profile.findFirst({ where: { role: 'CUSTOMER' }, include: { customer: true } });
    if (!firstProfile) {
      console.log('No customer profile found to test with.');
      return;
    }
    
    console.log(`Testing with UID: ${firstProfile.firebaseUid}`);
    const identifier = { customerId: firstProfile.customer.id, guestId: null };
    
    console.log('Step 2: CartService.getCart...');
    const cart = await CartService.getCart(identifier);
    console.log('Cart fetch successful:', !!cart);
    
    if (cart) {
      console.log('Cart Items:', cart.items.length);
    }
    
    console.log('--- SUCCESS ---');

  } catch (error) {
    console.error('--- ERROR DETECTED ---');
    console.error(error);
    if (error.stack) console.error(error.stack);
  } finally {
    process.exit();
  }
}

test();
