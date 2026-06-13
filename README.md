# Vantyrn Backend

## Shadowfax Delivery Integration

This project integrates with the Shadowfax 3PL logistics provider for automated delivery fulfillment.

### 1. Environment Variables Required

Ensure the following variables are present in your `.env` file before starting the server. NEVER commit the `.env` file to source control.

```env
# Base URLs
SFX_STAGING_BASE_URL=https://hlbackend.staging.shadowfax.in/
SFX_PROD_BASE_URL=https://api.shadowfax.in/

# Authentication Tokens
SFX_STAGING_TOKEN=your_staging_token_here
SFX_PROD_TOKEN=your_prod_token_here # Store in a secure Secrets Manager in production

# Configuration
SFX_STORE_CODE=your_store_code_here
SFX_WEBHOOK_SECRET=your_webhook_secret_here
SFX_REQUEST_TIMEOUT_MS=10000
SFX_RETRY_ATTEMPTS=3
```

### 2. Webhook Registration (Production Readiness)

Before going live, you must provide your production webhook endpoints to your Shadowfax Account Manager so they can register them on their end:
- **Status Callback URL:** `POST https://your-production-domain.com/webhooks/shadowfax/status`
- **Location Callback URL:** `POST https://your-production-domain.com/webhooks/shadowfax/location`

### 3. Rate Limit Awareness

The Shadowfax `/api/v2/store_serviceability/` endpoint is strictly throttled to **1200 requests/min**. If the customer app checks serviceability on every location change or cart update, it is highly recommended to introduce a **5-minute Redis TTL Cache** on the `checkServiceability` API route to prevent rate limit bans during high-traffic events.

### 4. Admin Observability

Any non-recoverable Shadowfax errors (such as network outages, failed cancellations, or API rejection) are automatically emitted via Socket.io to the `admin_global` room as an `sfx_error` event. The admin dashboard should listen to this event to manually intervene if an order fails to place.

```javascript
socket.on('sfx_error', (data) => {
  console.log(`SFX Error on Order ${data.orderId}: ${data.message}`);
});
```
