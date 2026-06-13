const { prisma } = require('../lib/prisma');
async function main() {
  const profile = await prisma.profile.findUnique({
    where: { id: 'aaf358a4-d694-4f41-bcaf-8f9dca510bfe' }
  });
  console.log(JSON.stringify(profile, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
