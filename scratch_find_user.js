const { prisma } = require('./lib/prisma');

async function run() {
  try {
    console.log('--- FETCHING ALL VENDORS & PROFILES ---');
    const vendors = await prisma.vendor.findMany({
      include: {
        profile: true
      }
    });

    console.log(`Found ${vendors.length} vendors in database:`);
    for (const v of vendors) {
      console.log(`\nVendor ID: ${v.id}`);
      console.log(`Business Name: ${v.businessName}`);
      console.log(`Owner Name: ${v.ownerName}`);
      console.log(`Email: ${v.email}`);
      console.log(`Phone Verified: ${v.phoneVerified}`);
      if (v.profile) {
        console.log(`Associated Profile ID: ${v.profile.id}`);
        console.log(`Firebase UID: ${v.profile.firebaseUid}`);
        console.log(`Profile Phone Number: ${v.profile.phoneNumber}`);
        console.log(`Profile Status: ${v.profile.profileStatus}`);
      } else {
        console.log('NO ASSOCIATED PROFILE!');
      }
    }
  } catch (error) {
    console.error('Error running search:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
