// Load environment variables if they are not already set (e.g., in local development)
if (!process.env.DATABASE_URL) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
}

// Standard require for @prisma/client works best when properly generated in the local node_modules
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// Prevent JSON serialization errors for BigInt fields (used in Shadowfax Order IDs)
BigInt.prototype.toJSON = function() {
  return this.toString();
};

let prismaClientInstance;

/**
 * Shared Prisma Client Initialization
 * Uses the standard 'pg' driver adapter for robust PostgreSQL connectivity.
 */
function getPrismaClient() {
  if (global.__prisma) return global.__prisma;
  if (prismaClientInstance) return prismaClientInstance;

  let connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    // Strip quotes and handle potential search_path or other query params
    connectionString = connectionString.replace(/^["'](.+)["']$/, '$1').trim();
    
    // Safety check: ensure search_path is handled if using Neon multi-schema
    if (connectionString.includes('neon.tech') && !connectionString.includes('search_path')) {
       console.log('[PRISMA] Detected Neon DB without search_path. Adding defaults...');
       const separator = connectionString.includes('?') ? '&' : '?';
       connectionString += `${separator}search_path=customer,vendor_delivery,public`;
    }
  }

  if (!connectionString) {
    console.error('[PRISMA] CRITICAL: DATABASE_URL is not defined. Server will start but DB queries will fail.');
    try {
      return new PrismaClient();
    } catch (e) {
      console.error('[PRISMA] Cannot create fallback client:', e.message);
      return {
        $queryRaw: () => Promise.reject(new Error('DATABASE_URL not configured')),
        $disconnect: () => Promise.resolve(),
      };
    }
  }

  // Set the environment variable for the internal engine (still needed by some Prisma internals)
  process.env.DATABASE_URL = connectionString;

  console.log('[PRISMA] Initializing standard Prisma Client with Driver Adapter...');
  
  try {
    const pool = new Pool({ 
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 60000, // 60s to handle NeonDB cold starts
      ssl: {
        rejectUnauthorized: false
      }
    });

    const adapter = new PrismaPg(pool);

    const prisma = new PrismaClient({
      adapter,
      log: ['error', 'warn'],
    });
    
    global.__prisma = prisma;
    prismaClientInstance = prisma;
    return prisma;
  } catch (err) {
    console.error('[PRISMA] Initialization Failed:', err.message);
    // Return a fallback client - will fail on first query, Stage 3 will catch it
    try {
      return new PrismaClient();
    } catch (fallbackErr) {
      console.error('[PRISMA] Fallback PrismaClient also failed:', fallbackErr.message);
      // Return a null-safe mock that throws on use
      return {
        $queryRaw: () => Promise.reject(new Error('Prisma not initialized')),
        $disconnect: () => Promise.resolve(),
      };
    }
  }
}

// Global instance management
const prisma = getPrismaClient();

/**
 * Helper to retry database operations if they fail due to transient issues (timeouts, etc.)
 */
async function withRetry(operation, maxRetries = 3, delay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isTimeout = error.code === 'ETIMEDOUT' || 
                        error.message?.includes('timeout') || 
                        error.message?.includes('ETIMEDOUT') ||
                        error.code === 'P2024'; // Prisma timeout code
      
      if (isTimeout && i < maxRetries - 1) {
        console.warn(`[PRISMA] Operation failed (timeout), retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      console.error('[PRISMA] Operation failed with non-retryable error:', error.message || error);
      throw error;
    }
  }
  console.error('[PRISMA] Operation failed after max retries:', lastError.message || lastError);
  throw lastError;
}

/**
 * Self-Healing Profile Utility
 * Ensures a Profile and Customer record exist for the authenticated user.
 */
async function getOrCreateCustomerProfile(user) {
  const { uid, phoneNumber, name } = user;
  
  console.log(`[PRISMA] Syncing profile for UID: ${uid}, Phone: ${phoneNumber}`);

  // 1. Ensure Profile exists (Self-Healing Lookup)
  let profile = await withRetry(async () => {
    // A. Check by Firebase UID first (Most reliable for social login)
    let p = await prisma.profile.findUnique({
      where: { firebaseUid: uid },
      include: { customer: { include: { ageVerification: true } } }
    });

    if (p) return p;

    // B. Check by Phone Number if UID didn't match (Identity Adoption)
    if (phoneNumber) {
      p = await prisma.profile.findFirst({
        where: { phoneNumber },
        include: { customer: { include: { ageVerification: true } } }
      });

      if (p) {
        console.log(`[PRISMA] Identity adopt: Link phone ${phoneNumber} to new UID ${uid}`);
        return await prisma.profile.update({
          where: { id: p.id },
          data: { firebaseUid: uid, role: 'CUSTOMER' },
          include: { customer: { include: { ageVerification: true } } }
        });
      }
    }

    // C. Fresh Create if nothing found (Race-Condition Safe)
    console.log(`[PRISMA] Fresh identity: Create profile for UID ${uid}`);
    try {
      return await prisma.profile.create({
        data: {
          firebaseUid: uid,
          phoneNumber: phoneNumber || null,
          role: 'CUSTOMER',
          profileStatus: 'ACTIVE'
        },
        include: { customer: { include: { ageVerification: true } } }
      });
    } catch (createError) {
      if (createError.code === 'P2002') {
        console.log('[PRISMA] Profile creation race-condition, re-fetching...');
        return await prisma.profile.findFirst({
          where: { OR: [{ firebaseUid: uid }, ...(phoneNumber ? [{ phoneNumber }] : [])] },
          include: { customer: { include: { ageVerification: true } } }
        });
      }
      throw createError;
    }
  });

  // 2. Ensure Customer record exists
  if (!profile.customer) {
    console.log(`[PRISMA] Creating missing customer record for UID: ${uid}`);
    let customer = await prisma.customer.findUnique({
        where: { profileId: profile.id },
        include: { ageVerification: true }
    });

    if (!customer) {
        try {
            customer = await prisma.customer.create({
                data: {
                    profileId: profile.id,
                    fullName: user.name || 'Customer',
                    email: user.email
                },
                include: { ageVerification: true }
            });
        } catch (createError) {
            // Race-condition safe: on first login the app fires several authed
            // requests at once (cart/address/profile/fcm). They all see no
            // customer and try to create one → only the first wins; the rest hit
            // P2002 (unique profile_id or email). Re-fetch the row that now exists.
            if (createError.code === 'P2002') {
                console.log('[PRISMA] Customer creation race-condition, re-fetching...');
                // profileId is unique (one customer per profile), so this returns
                // THIS profile's customer that the winning concurrent request just
                // created. If it's null, the conflict was a genuine email clash
                // with another account — let that surface rather than adopting a
                // customer that belongs to a different profile.
                customer = await prisma.customer.findUnique({
                    where: { profileId: profile.id },
                    include: { ageVerification: true }
                });
                if (!customer) throw createError;
            } else {
                throw createError;
            }
        }
    } else {
        customer = await prisma.customer.update({
            where: { id: customer.id },
            data: { 
              email: user.email || undefined,
              fullName: user.name || undefined
            },
            include: { ageVerification: true }
        });
    }
    profile.customer = customer;
  } else {
    // 3. Sync if needed (e.g. email or name updated in Google/Firebase)
    const needsSync = (phoneNumber && profile.phoneNumber !== phoneNumber) || 
                      (user.email && profile.customer.email !== user.email);
    
    if (needsSync) {
        profile = await prisma.profile.update({
            where: { id: profile.id },
            data: { 
              phoneNumber: phoneNumber || undefined,
              customer: {
                update: {
                  email: user.email || undefined,
                  fullName: (profile.customer.fullName === 'Customer' && user.name) ? user.name : undefined
                }
              }
            },
            include: { customer: { include: { ageVerification: true } } }
        });
    }
  }

  return profile;
}

module.exports = { prisma, withRetry, getOrCreateCustomerProfile };
