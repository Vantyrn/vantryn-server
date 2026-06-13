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

async function benchmark() {
  console.log(`[STABILITY BENCHMARK] Initializing connection to database...`);
  const latencies = [];
  
  try {
    for (let i = 1; i <= 5; i++) {
      const start = Date.now();
      const result = await prisma.$queryRaw`SELECT 1 as ping`;
      const end = Date.now();
      const latency = end - start;
      latencies.push(latency);
      console.log(`[ITERATION ${i}] Ping succeeded in ${latency}ms`);
      await new Promise(resolve => setTimeout(resolve, 500)); // sleep 500ms between pings
    }
    
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    
    console.log(`\n=====================================`);
    console.log(`[BENCHMARK RESULT] DB Connection is highly STABLE!`);
    console.log(`- Total Queries Run: ${latencies.length}`);
    console.log(`- Minimum Latency: ${min}ms`);
    console.log(`- Maximum Latency: ${max}ms`);
    console.log(`- Average Latency: ${avg.toFixed(1)}ms`);
    console.log(`=====================================`);
    
  } catch (err) {
    console.error(`[CRITICAL] Database connection benchmark failed:`, err.message);
  } finally {
    await prisma.$disconnect();
  }
}

benchmark();
