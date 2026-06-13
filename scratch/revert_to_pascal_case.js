const fs = require('fs');
const path = require('path');

const replacements = [
  // Prisma Client Accessors (Revert to PascalCase)
  { from: /prisma\.vendor_kyc\b/g, to: 'prisma.vendorKyc' },
  { from: /prisma\.vendor_bank_details\b/g, to: 'prisma.vendorBankDetails' },
  { from: /prisma\.product_addon\b/g, to: 'prisma.productAddon' },
  { from: /prisma\.product_template\b/g, to: 'prisma.productTemplate' },
  { from: /prisma\.vendor_order_action\b/g, to: 'prisma.vendorOrderAction' },
  { from: /prisma\.vendor_earning\b/g, to: 'prisma.vendorEarning' },
  { from: /prisma\.product_review_submission\b/g, to: 'prisma.productReviewSubmission' },
  { from: /prisma\.product_review_snapshot\b/g, to: 'prisma.productReviewSnapshot' },
  { from: /prisma\.vendor_sla_metric\b/g, to: 'prisma.vendorSlaMetric' },
  { from: /prisma\.notification_log\b/g, to: 'prisma.notificationLog' },
  { from: /prisma\.rider_assignment_attempt\b/g, to: 'prisma.riderAssignmentAttempt' },
  { from: /prisma\.rider_earning\b/g, to: 'prisma.riderEarning' },
  { from: /prisma\.rider_ratings_summary\b/g, to: 'prisma.riderRatingsSummary' },
  { from: /prisma\.cart_item\b/g, to: 'prisma.cartItem' },
  { from: /prisma\.order_item\b/g, to: 'prisma.orderItem' },
  { from: /prisma\.order_status_history\b/g, to: 'prisma.orderStatusHistory' },
  { from: /prisma\.order_tracking\b/g, to: 'prisma.orderTracking' },
  { from: /prisma\.age_verification\b/g, to: 'prisma.ageVerification' },
  { from: /prisma\.analytics_event\b/g, to: 'prisma.analyticsEvent' },
  { from: /prisma\.login_attempt_log\b/g, to: 'prisma.loginAttemptLog' },
  { from: /prisma\.guest_session\b/g, to: 'prisma.guestSession' },
  { from: /prisma\.otp_request\b/g, to: 'prisma.otpRequest' },
  { from: /prisma\.payment_transaction\b/g, to: 'prisma.paymentTransaction' },
  { from: /prisma\.support_request\b/g, to: 'prisma.supportRequest' },

  // Relation names in include/select/data (snake_case -> camelCase)
  { from: /\bvendor_kyc\s*:/g, to: 'kyc:' }, // Check schema line 380
  { from: /\bvendor_bank_details\s*:/g, to: 'bankDetails:' },
  { from: /\bvendor_compliance_flags\s*:/g, to: 'complianceFlags:' },
  { from: /\bproduct_addons\s*:/g, to: 'addOns:' },
  { from: /\bproduct_review_submissions\s*:/g, to: 'productReviewSubmissions:' },
  { from: /\bproduct_review_snapshots\s*:/g, to: 'snapshots:' },
  { from: /\bproduct_images\s*:/g, to: 'productImages:' },
  { from: /\bpickup_requests\s*:/g, to: 'pickupRequests:' },
  { from: /\bdelivery_status_updates\s*:/g, to: 'deliveryStatusUpdates:' },
  { from: /\bvendor_order_actions\s*:/g, to: 'orderActions:' },
  { from: /\bvendor_earnings\s*:/g, to: 'earnings:' },
  { from: /\border_status_history\s*:/g, to: 'statusHistory:' },
  { from: /\border_tracking\s*:/g, to: 'tracking:' },
  { from: /\bcart_items\s*:/g, to: 'items:' },
  { from: /\blogin_attempt_logs\s*:/g, to: 'loginAttemptLogs:' },
  { from: /\botp_requests\s*:/g, to: 'otpRequests:' },
  { from: /\border_items\s*:/g, to: 'items:' },
  { from: /\bpayment_transactions\s*:/g, to: 'paymentTransactions:' },
  { from: /\bsupport_requests\s*:/g, to: 'supportRequests:' },
  { from: /\banalytics_events\s*:/g, to: 'analyticsEvents:' },
  { from: /\bage_verification\s*:/g, to: 'ageVerification:' },
];

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  replacements.forEach(rep => {
    content = content.replace(rep.from, rep.to);
  });

  // Revert manual "items" fixes
  content = content.replace(/\bcart\.cart_items\b/g, 'cart.items');
  content = content.replace(/\border\.order_items\b/g, 'order.items');

  if (content !== original) {
    fs.writeFileSync(filePath, content);
    console.log(`Reverted: ${filePath}`);
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
console.log(`Starting revert in ${targetDir}...`);
walkDir(targetDir);
console.log('Revert complete.');
