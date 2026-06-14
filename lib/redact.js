// Secret / PII redaction for logs and Sentry events.
// MANDATORY (workflow §4.5): never ship OTP codes, Firebase/JWT tokens,
// raw card/UPI data; mask phone/email/address. The current codebase logs
// mock tokens — that pattern must not reach the pilot build.

const REDACTED = '[REDACTED]';

// Keys whose VALUE is fully removed (matched case-insensitively as substrings,
// except where anchored with \b to avoid over-matching e.g. statusCode/clientCode).
const FULL_REDACT = [
  /pass(word|wd)?/i,
  /secret/i,
  /token/i, // idToken, accessToken, refreshToken, sessionToken
  /authorization/i,
  /\bauth\b/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /\botp\b/i,
  /verification[-_]?code/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /card[-_]?number/i,
  /\bpan\b/i,
  /razorpay[-_]?signature/i,
];

// Keys whose value is partially masked rather than removed.
const MASK = [
  { test: /(phone|mobile|msisdn|whatsapp)/i, fn: maskPhone },
  { test: /e?mail/i, fn: maskEmail },
  { test: /(address|street|line1|line2|landmark)/i, fn: maskGeneric },
];

// Reserved winston/correlation fields we never touch.
const SKIP_KEYS = new Set([
  'level', 'message', 'timestamp', 'service', 'env', 'releaseVersion',
  'requestId', 'userId', 'role', 'orderId', 'route', 'method', 'statusCode',
  'latencyMs', 'screen',
]);

function maskPhone(v) {
  const s = String(v);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 4) return REDACTED;
  return `***${digits.slice(-4)}`;
}

function maskEmail(v) {
  const s = String(v);
  const at = s.indexOf('@');
  if (at <= 0) return REDACTED;
  const name = s.slice(0, at);
  return `${name[0]}***@${s.slice(at + 1)}`;
}

function maskGeneric(v) {
  const s = String(v);
  if (s.length <= 4) return REDACTED;
  return `${s.slice(0, 2)}***`;
}

function keyAction(key) {
  for (const re of FULL_REDACT) if (re.test(key)) return 'redact';
  for (const m of MASK) if (m.test.test(key)) return m.fn;
  return null;
}

// Scrub long bearer/JWT-looking tokens out of free-text messages.
function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9._\-]{20,}/g, '[REDACTED_JWT]');
}

function redactDeep(value, depth, seen) {
  if (value == null) return value;
  if (depth > 6) return '[TRUNCATED_DEPTH]';

  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    const max = 50;
    const out = value.slice(0, max).map((v) => redactDeep(v, depth + 1, seen));
    if (value.length > max) out.push(`[+${value.length - max} more]`);
    return out;
  }

  const out = {};
  for (const key of Object.keys(value)) {
    if (SKIP_KEYS.has(key)) { out[key] = value[key]; continue; }
    const action = keyAction(key);
    if (action === 'redact') { out[key] = REDACTED; continue; }
    if (typeof action === 'function') { out[key] = action(value[key]); continue; }
    out[key] = redactDeep(value[key], depth + 1, seen);
  }
  return out;
}

/** Redact a plain object (mutating-safe: returns a scrubbed copy). */
function redact(obj) {
  return redactDeep(obj, 0, new WeakSet());
}

module.exports = { redact, scrubString, REDACTED };
