// Map the authoritative Vendor.accountStatus onto Profile.profileStatus.
//
// accountStatus is the source of truth for the KYC/approval lifecycle. The app routes off
// profileStatus, so the two must agree — otherwise a genuinely PENDING (unregistered) vendor
// whose profileStatus is a stale 'ACTIVE' is let straight onto the operational dashboard.
// The old sync only handled ACTIVE/APPROVED and UNDER_REVIEW/KYC_SUBMITTED; a 'PENDING' or
// 'REJECTED' accountStatus fell through and left whatever stale value profileStatus held.
//
// Admin blocks (SUSPENDED, DISABLED:<expiry>) live ONLY on profileStatus — the timed-disable
// expiry has no accountStatus equivalent — so those are preserved untouched.
function profileStatusForAccount(accountStatus, currentProfileStatus) {
  if (currentProfileStatus === 'SUSPENDED') return 'SUSPENDED';
  if (currentProfileStatus && currentProfileStatus.startsWith('DISABLED:')) return currentProfileStatus;

  switch (accountStatus) {
    case 'ACTIVE':
    case 'APPROVED':      return 'ACTIVE';
    case 'UNDER_REVIEW':
    case 'KYC_SUBMITTED':  return 'UNDER_REVIEW';
    case 'REJECTED':       return 'REJECTED';
    case 'SUSPENDED':      return 'SUSPENDED';
    case 'DISABLED':       return 'DISABLED';
    case 'PENDING':        return 'PENDING';
    default:               return currentProfileStatus || 'PENDING';
  }
}

module.exports = { profileStatusForAccount };
