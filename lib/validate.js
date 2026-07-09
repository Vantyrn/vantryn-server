const { z } = require('zod');
const logger = require('./logger');

// Express middleware factory: validate req.body against a zod schema.
// On failure → 400 with a client-safe message naming the bad field. On success,
// req.body is replaced with the parsed (coerced/normalized) data. Use .passthrough()
// on schemas that should preserve unknown keys (most existing handlers expect this).
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      const first = result.error.issues[0];
      const field = first?.path?.join('.') || '';
      logger.warn('validation.failed', { url: req.originalUrl, field, message: first?.message });
      return res.status(400).json({
        error: 'Invalid request',
        code: 'VALIDATION_ERROR',
        field: field || undefined,
        message: first ? `${field ? field + ': ' : ''}${first.message}` : 'Invalid request body',
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody, z };
