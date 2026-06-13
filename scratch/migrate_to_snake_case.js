const fs = require('fs');
const path = require('path');

const replacements = [
  // Prisma Client Accessors
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

  // Relation names in include/select
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
  { from: /\boperatingHours\s*:/g, to: 'vendor_operating_hours:' },
  { from: /\bkcyDocs\s*:/g, to: 'vendor_kyc:' }, // Typos in existing code?

  // Relation property access on objects (v.bankDetails -> v.vendor_bank_details)
  { from: /\.bankDetails\b/g, to: '.vendor_bank_details' },
  { from: /\.complianceFlags\b/g, to: '.vendor_compliance_flags' },
  { from: /\.addOns\b/g, to: '.product_addons' },
  { from: /\.orderActions\b/g, to: '.vendor_order_actions' },
  { from: /\.earnings\b/g, to: '.vendor_earnings' },
  { from: /\.productSubmissions\b/g, to: '.product_review_submissions' },
  { from: /\.operatingHours\b/g, to: '.vendor_operating_hours' },
];

function migrateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  replacements.forEach(({ from, to }) => {
    content = content.replace(from, to);
  });

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
