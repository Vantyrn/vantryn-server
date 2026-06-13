const Redis = require('ioredis');

// Shared Redis connection logic with global singleton
if (!global.__redisConnection) {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    console.log('[REDIS] Initializing with REDIS_URL');
    global.__redisConnection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
      enableOfflineQueue: false, // Upstash/BullMQ optimization
      tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
      retryStrategy(times) {
        return Math.min(times * 500, 5000);
      }
    });
  } else {
    const redisConfig = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      lazyConnect: false,
      connectTimeout: 5000, 
      maxRetriesPerRequest: null,
      enableOfflineQueue: false, // Upstash/BullMQ optimization
      tls: process.env.REDIS_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
      retryStrategy(times) {
        return Math.min(times * 500, 5000);
      },
    };
    global.__redisConnection = new Redis(redisConfig);
  }

  global.__redisConnection.on('error', (err) => {
    if (process.env.DEBUG_REDIS) {
      console.error('[REDIS] Connection Error:', err.message);
    }
  });

  global.__redisConnection.on('connect', () => {
    console.log('[REDIS] Connected successfully to Redis');
  });
}

const connection = global.__redisConnection;

module.exports = {
  connection
};
