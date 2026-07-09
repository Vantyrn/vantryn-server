const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const env = require('../../../config/env');
const logger = require('../../../../lib/logger');

// Endpoint + token are chosen by SFX_ENV (staging|production), NOT NODE_ENV, so we can point at
// real staging from any Node env and flip to production by changing a single flag.
const activeBaseUrl = env.SFX_ACTIVE_BASE_URL;
const activeToken = env.SFX_ACTIVE_TOKEN;

const shadowfaxClient = axios.create({
  baseURL: activeBaseUrl,
  timeout: env.SFX_REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Request Interceptor
shadowfaxClient.interceptors.request.use(
  (config) => {
    if (activeToken) {
      // Shadowfax store-based (HL) API authenticates with a "Token" scheme:
      //   Authorization: Token <token_id>
      // Accept a token that already includes the scheme; otherwise prefix it.
      config.headers['Authorization'] = /^token\s/i.test(activeToken) ? activeToken : `Token ${activeToken}`;
    }
    logger.info(`[Shadowfax API Request] ${config.method.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response Interceptor
shadowfaxClient.interceptors.response.use(
  (response) => {
    logger.info(`[Shadowfax API Response] ${response.config.method.toUpperCase()} ${response.config.url} - Status: ${response.status}`);
    return response;
  },
  (error) => {
    if (error.response) {
      logger.error(`[Shadowfax API Error] ${error.config.method.toUpperCase()} ${error.config.url} - Status: ${error.response.status} - Data: ${JSON.stringify(error.response.data)}`);
    } else {
      logger.error(`[Shadowfax API Error] Network/Timeout error: ${error.message}`);
    }
    return Promise.reject(error);
  }
);

// Retry logic: Retry on 5xx errors or network errors
axiosRetry(shadowfaxClient, {
  retries: env.SFX_RETRY_ATTEMPTS,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && error.response.status >= 500);
  }
});

module.exports = shadowfaxClient;
