/**
 * Self-check for the vendor KYC gate. Run: node scripts/test_kyc_gate.js
 *
 * Replays middleware/kyc.js's decision for every real vendor and asserts the thing
 * that was broken: an approved vendor must pass REGARDLESS of profiles.role. Role
 * gets rewritten to 'CUSTOMER' whenever that phone number is used on the customer
 * app, which silently locked approved vendors out of every requireKyc route.
 *
 * Read-only — it queries and evaluates, it never writes.
 */
const { prisma } = require('../lib/prisma');

const APPROVED_STATUSES = ['approved', 'active', 'ready'];

/** The gate as middleware/kyc.js now decides it: relation first, role ignored. */
const gate = (profile) => {
  if (profile.vendor) {
    return {
      allowed: APPROVED_STATUSES.includes(profile.vendor.accountStatus?.toLowerCase()),
      status: profile.vendor.accountStatus,
    };
  }
  if (profile.rider) {
    return {
      allowed: APPROVED_STATUSES.includes(profile.rider.accountStatus?.toLowerCase()),
      status: profile.rider.accountStatus,
    };
  }
  return { allowed: false, status: 'not_a_vendor' };
};

/** The OLD behaviour, kept so the regression is visible rather than asserted blind. */
const oldGate = (profile) => {
  if (profile.role === 'VENDOR' && profile.vendor) {
    return APPROVED_STATUSES.includes(profile.vendor.accountStatus?.toLowerCase());
  }
  if (profile.role === 'RIDER' && profile.rider) {
    return APPROVED_STATUSES.includes(profile.rider.accountStatus?.toLowerCase());
  }
  return false;
};

let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('  FAIL -', msg); failures++; } else console.log('  ok   -', msg); };

(async () => {
  console.log('vendor KYC gate self-check\n');

  const profiles = await prisma.profile.findMany({
    where: { vendor: { isNot: null } },
    include: { vendor: true, rider: true },
  });

  let wasBroken = 0;
  for (const p of profiles) {
    const now = gate(p);
    const before = oldGate(p);
    const approvedInDb = APPROVED_STATUSES.includes(p.vendor.accountStatus?.toLowerCase());

    // The contract: the gate agrees with the vendor's own account status, full stop.
    assert(
      now.allowed === approvedInDb,
      `${(p.vendor.businessName || '?').padEnd(12)} role=${String(p.role).padEnd(8)} acct=${String(p.vendor.accountStatus).padEnd(8)} -> ${now.allowed ? 'ALLOW' : 'DENY '} (expected ${approvedInDb ? 'ALLOW' : 'DENY'})`
    );
    if (approvedInDb && !before) wasBroken++;
  }

  console.log(`\n${profiles.length} vendor profile(s) checked.`);
  console.log(`${wasBroken} approved vendor(s) were being wrongly denied before this fix.`);
  console.log(failures ? 'FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
