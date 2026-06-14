// Request-logging + correlation middleware (workflow §4.5).
// Creates/propagates a requestId, opens an AsyncLocalStorage scope so every log
// line during the request inherits requestId/userId/role/orderId, and emits a
// structured start/finish log with latency + status.
const crypto = require('crypto');
const logger = require('../lib/logger');
const { runWithContext, setContext } = require('../lib/logContext');

// Paths we don't want flooding the log sink at info level.
const QUIET = new Set(['/health', '/api/health', '/api/health/status', '/favicon.ico']);

function requestContext(req, res, next) {
  // Reuse the client's requestId if it sent one (mobile sends x-request-id so
  // device logs join up with backend logs), else mint one.
  const incoming = req.headers['x-request-id'];
  const requestId = (typeof incoming === 'string' && incoming.length <= 64 && incoming) || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const start = Date.now();
  const quiet = QUIET.has(req.path);

  runWithContext({ requestId }, () => {
    if (!quiet) {
      logger.debug('request.start', { method: req.method, url: req.originalUrl });
    }

    res.on('finish', () => {
      // Enrich from whatever auth/handlers attached during the request.
      if (req.user && req.user.uid) setContext({ userId: req.user.uid });
      const orderId = req.params?.orderId || req.params?.id || req.body?.orderId;
      if (orderId) setContext({ orderId: String(orderId) });

      const latencyMs = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      if (quiet && level === 'info') return; // skip healthy health-check noise
      logger.log(level, 'request.finish', {
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        latencyMs,
      });
    });

    next();
  });
}

module.exports = requestContext;
