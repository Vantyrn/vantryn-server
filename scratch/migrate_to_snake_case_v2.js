const fs = require('fs');
const path = require('path');

const replacements = [
  // Prisma Client Accessors (Models renamed to snake_case)
  { from: /prisma\.vendorKyc\b/g, to: 'prisma.vendor_kyc' },
  { from: /prisma\.vendorBankDetails\b/g, to: 'prisma.vendor_bank_details' },
  { from: /prisma\.productAddon\b/g, to: 'prisma.product_addon' },
  { from: /prisma\.productTemplate\b/g, to: 'prisma.product_template' },
  { from: /prisma\.vendorOrderAction\b/g, to: 'prisma.vendor_order_action' },
  { from: /prisma\.vendorEarning\b/g, to: 'prisma.vendor_earning' },
  { from: /prisma\.productReviewSubmission\b/g, to: 'prisma.product_review_submission' },
  { from: /prisma\.productReviewSnapshot\b/g, to: 'prisma.product_review_snapshot' },
  { from: /prisma\.vendorSlaMetric\b/g, to: 'prisma.vendor_sla_metric' },
  { from: /prisma\.notificationLog\b/g, to: 'prisma.notification_log' },
  { from: /prisma\.riderAssignmentAttempt\b/g, to: 'prisma.rider_assignment_attempt' },
  { from: /prisma\.riderEarning\b/g, to: 'prisma.rider_earning' },
  { from: /prisma\.riderRatingsSummary\b/g, to: 'prisma.rider_ratings_summary' },
  { from: /prisma\.cartItem\b/g, to: 'prisma.cart_item' },
  { from: /prisma\.orderItem\b/g, to: 'prisma.order_item' },
  { from: /prisma\.orderStatusHistory\b/g, to: 'prisma.order_status_history' },
  { from: /prisma\.orderTracking\b/g, to: 'prisma.order_tracking' },
  { from: /prisma\.ageVerification\b/g, to: 'prisma.age_verification' },
  { from: /prisma\.analyticsEvent\b/g, to: 'prisma.analytics_event' },
  { from: /prisma\.loginAttemptLog\b/g, to: 'prisma.login_attempt_log' },
  { from: /prisma\.guestSession\b/g, to: 'prisma.guest_session' },
  { from: /prisma\.otpRequest\b/g, to: 'prisma.otp_request' },
  { from: /prisma\.paymentTransaction\b/g, to: 'prisma.payment_transaction' },
  { from: /prisma\.supportRequest\b/g, to: 'prisma.support_request' },

  // Relation names in include/select/data (camelCase -> snake_case)
  { from: /\bkycDocs\s*:/g, to: 'vendor_kyc:' },
  { from: /\bbankDetails\s*:/g, to: 'vendor_bank_details:' },
  { from: /\bcomplianceFlags\s*:/g, to: 'vendor_compliance_flags:' },
  { from: /\baddOns\s*:/g, to: 'product_addons:' },
  { from: /\bproductSubmissions\s*:/g, to: 'product_review_submissions:' },
  { from: /\bsnapshots\s*:/g, to: 'product_review_snapshots:' },
  { from: /\bproductImages\s*:/g, to: 'product_images:' },
  { from: /\bpickupRequests\s*:/g, to: 'pickup_requests:' },
  { from: /\bdeliveryStatusUpdates\s*:/g, to: 'delivery_status_updates:' },
  { from: /\bvendorOrderActions\s*:/g, to: 'vendor_order_actions:' },
  { from: /\bvendorEarning\s*:/g, to: 'vendor_earnings:' },
  { from: /\borderActions\s*:/g, to: 'vendor_order_actions:' },
  { from: /\bearnings\s*:/g, to: 'vendor_earnings:' },
  { from: /\bstatusHistory\s*:/g, to: 'order_status_history:' },
  { from: /\btracking\s*:/g, to: 'order_tracking:' },
  { from: /\bcartItems\s*:/g, to: 'cart_items:' },
  { from: /\bloginAttemptLogs\s*:/g, to: 'login_attempt_logs:' },
  { from: /\botpRequests\s*:/g, to: 'otp_requests:' },
  { from: /\borderItems\s*:/g, to: 'order_items:' },
  { from: /\bpaymentTransactions\s*:/g, to: 'payment_transactions:' },
  { from: /\bsupportRequests\s*:/g, to: 'support_requests:' },
  { from: /\banalyticsEvents\s*:/g, to: 'analytics_events:' },
  { from: /\bageVerification\s*:/g, to: 'age_verification:' },
  
  // Specific fixes for Cart/Order items in include
  { from: /prisma\.cart\.findUnique\({[^}]*include:\s*{\s*items:\s*true/g, to: m => m.replace('items:', 'cart_items:') },
  { from: /prisma\.cart\.findFirst\({[^}]*include:\s*{\s*items:\s*true/g, to: m => m.replace('items:', 'cart_items:') },
  { from: /prisma\.order\.findUnique\({[^}]*include:\s*{\s*items:\s*true/g, to: m => m.replace('items:', 'order_items:') },
  { from: /prisma\.order\.findFirst\({[^}]*include:\s*{\s*items:\s*true/g, to: m => m.replace('items:', 'order_items:') },
];

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  replacements.forEach(rep => {
    content = content.replace(rep.from, rep.to);
  });

  // Manual fixes for "items" in common contexts
  content = content.replace(/\bcart\.items\b/g, 'cart.cart_items');
  content = content.replace(/\border\.items\b/g, 'order.order_items');
  
  // Fix "items: { create: ... }" in prisma create calls
  content = content.replace(/prisma\.order\.create\({[^}]*items:\s*{/g, m => m.replace('items:', 'order_items:'));
  content = content.replace(/prisma\.cart\.create\({[^}]*items:\s*{/g, m => m.replace('items:', 'cart_items:'));

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`Updated: ${filePath}`);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== 'scratch' && file !== 'scripts') {
        walkDir(fullPath);
      }
    } else if (file.endsWith('.js')) {
      migrateFile(fullPath);
    }
  });
}

const targetDir = path.join(__dirname, '..');
console.log(`Starting migration in ${targetDir}...`);
walkDir(targetDir);
console.log('Migration complete.');
