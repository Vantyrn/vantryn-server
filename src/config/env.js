require('dotenv').config();

const config = {
  SFX_STAGING_BASE_URL: process.env.SFX_STAGING_BASE_URL || 'https://hlbackend.staging.shadowfax.in',
  SFX_PROD_BASE_URL: process.env.SFX_PROD_BASE_URL || 'https://api.shadowfax.in',
  SFX_STAGING_TOKEN: process.env.SFX_STAGING_TOKEN,
  SFX_PROD_TOKEN: process.env.SFX_PROD_TOKEN,
  SFX_WEBHOOK_SECRET: process.env.SFX_WEBHOOK_SECRET,
  // Marketplace `client_code`. Env-specific, so it rides the same SFX_ENV switch as the token.
  SFX_CLIENT_CODE: process.env.SFX_CLIENT_CODE,
  SFX_STAGING_CLIENT_CODE: process.env.SFX_STAGING_CLIENT_CODE,
  SFX_PROD_CLIENT_CODE: process.env.SFX_PROD_CLIENT_CODE,
  SFX_REQUEST_TIMEOUT_MS: parseInt(process.env.SFX_REQUEST_TIMEOUT_MS || '10000', 10),
  SFX_RETRY_ATTEMPTS: parseInt(process.env.SFX_RETRY_ATTEMPTS || '3', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  USE_SANDBOX_PAYMENTS: process.env.USE_SANDBOX_PAYMENTS === 'true' || (process.env.NODE_ENV !== 'production'),

  // Delivery mode is INDEPENDENT of the payment sandbox. This lets us run
  // "placeholder payment + REAL Shadowfax" or "placeholder payment + local simulator":
  //   'simulate' → drive the built-in rider simulator (no Shadowfax calls; testable on localhost, no webhook tunnel needed)
  //   'live'     → call the real Shadowfax store-based API and drive tracking from its webhooks
  // Defaults to 'simulate' so local dev keeps working without Shadowfax credentials or a public webhook URL.
  SFX_DELIVERY_MODE: (process.env.SFX_DELIVERY_MODE || 'simulate').toLowerCase(),

  // Which Shadowfax environment to hit. Deliberately DECOUPLED from NODE_ENV so we can run the
  // real staging Shadowfax API from any Node env, and flip to production by changing ONLY this flag.
  //   'staging'    → SFX_STAGING_BASE_URL + SFX_STAGING_TOKEN
  //   'production' → SFX_PROD_BASE_URL   + SFX_PROD_TOKEN
  SFX_ENV: (process.env.SFX_ENV || 'staging').toLowerCase()
};

// Convenience flag used throughout the delivery layer.
config.SFX_LIVE = config.SFX_DELIVERY_MODE === 'live';

// Active Shadowfax endpoint + token, selected purely by SFX_ENV (one-flag staging→prod switch).
const isProdSfx = config.SFX_ENV === 'production';
config.SFX_ACTIVE_BASE_URL = isProdSfx ? config.SFX_PROD_BASE_URL : config.SFX_STAGING_BASE_URL;
config.SFX_ACTIVE_TOKEN = isProdSfx ? config.SFX_PROD_TOKEN : config.SFX_STAGING_TOKEN;
config.SFX_ACTIVE_CLIENT_CODE =
  (isProdSfx ? config.SFX_PROD_CLIENT_CODE : config.SFX_STAGING_CLIENT_CODE) || config.SFX_CLIENT_CODE;

if (config.SFX_LIVE && !config.SFX_ACTIVE_TOKEN) {
  console.warn(`[CONFIG] WARNING: SFX_DELIVERY_MODE=live but no ${isProdSfx ? 'SFX_PROD_TOKEN' : 'SFX_STAGING_TOKEN'} set. Shadowfax calls will fail until it is configured.`);
  config.SFX_MISSING = true;
}

module.exports = config;
