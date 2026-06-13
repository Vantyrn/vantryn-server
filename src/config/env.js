require('dotenv').config();

const config = {
  SFX_STAGING_BASE_URL: process.env.SFX_STAGING_BASE_URL || 'https://hlbackend.staging.shadowfax.in',
  SFX_PROD_BASE_URL: process.env.SFX_PROD_BASE_URL || 'https://api.shadowfax.in',
  SFX_STAGING_TOKEN: process.env.SFX_STAGING_TOKEN,
  SFX_PROD_TOKEN: process.env.SFX_PROD_TOKEN,
  SFX_STORE_CODE: process.env.SFX_STORE_CODE,
  SFX_WEBHOOK_SECRET: process.env.SFX_WEBHOOK_SECRET,
  SFX_CLIENT_CODE: process.env.SFX_CLIENT_CODE,
  SFX_REQUEST_TIMEOUT_MS: parseInt(process.env.SFX_REQUEST_TIMEOUT_MS || '10000', 10),
  SFX_RETRY_ATTEMPTS: parseInt(process.env.SFX_RETRY_ATTEMPTS || '3', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  USE_SANDBOX_PAYMENTS: process.env.USE_SANDBOX_PAYMENTS === 'true' || (process.env.NODE_ENV !== 'production')
};

const activeToken = config.NODE_ENV === 'production' ? config.SFX_PROD_TOKEN : config.SFX_STAGING_TOKEN;

if (!activeToken) {
  console.warn('[CONFIG] WARNING: Missing Shadowfax credentials (Token). Delivery features will fail until these are configured.');
  config.SFX_MISSING = true;
}

module.exports = config;
