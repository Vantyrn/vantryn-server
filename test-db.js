const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ 
  connectionString,
  ssl: { rejectUnauthorized: false }
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function test() {
  try {
    console.log('Testing connection with adapter...');
    const result = await prisma.$queryRaw`SELECT 1 as result`;
    console.log('Connection successful:', result);
    
    console.log('Testing Profile query...');
    const profile = await prisma.profile.findFirst({ include: { vendor: true } });
    console.log('Profile query successful:', profile ? 'Found' : 'None');
    
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await prisma.$disconnect();
  }
}

test();
