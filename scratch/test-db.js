const prisma = require('../lib/prisma');

async function main() {
  try {
    console.log('--- Testing Database Connection ---');
    const userCount = await prisma.profile.count();
    console.log('Current profile count:', userCount);
    
    console.log('--- Attempting to create test profile ---');
    const testUid = 'debug-' + Date.now();
    const profile = await prisma.profile.create({
      data: {
        firebaseUid: testUid,
        phoneNumber: 'test-phone',
        role: 'VENDOR',
        profileStatus: 'PENDING'
      }
    });
    console.log('Test profile created successfully:', profile.firebaseUid);
    
    // Clean up
    await prisma.profile.delete({ where: { firebaseUid: testUid } });
    console.log('Cleanup successful.');
  } catch (err) {
    console.error('DATABASE ERROR:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
