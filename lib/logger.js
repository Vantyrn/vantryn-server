// Central structured logger for the Vantryn backend (workflow §4.5).
//
// - Structured JSON, sink-agnostic: Console always; Grafana Loki transport
//   added when LOKI_URL is set (swap to OpenObserve later = env change, no code).
// - Every line auto-inherits the request correlation context (requestId /
//   userId / role / orderId) via AsyncLocalStorage — see lib/logContext.js.
// - Secrets / PII are redacted before anything leaves the process — see lib/redact.js.
//
// Backward compatible: `require('./lib/logger')` still returns a winston logger
// with .info/.warn/.error/.debug.
const winston = require('winston');
const { getContext } = require('./logContext');
const { redact } = require('./redact');

const SERVICE = 'server';
const ENV = process.env.NODE_ENV || 'development';
const RELEASE = process.env.RELEASE_VERSION || 'dev';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// 1. Inject request-scoped correlation + static service metadata.
const injectContext = winston.format((info) => {
  const ctx = getContext();
  if (ctx.requestId) info.requestId = ctx.requestId;
  if (ctx.userId) info.userId = ctx.userId;
  if (ctx.role) info.role = ctx.role;
  if (ctx.orderId) info.orderId = ctx.orderId;
  // Don't clobber an origin already set by the caller (e.g. relayed mobile logs
  // from /api/telemetry/logs carry service:"customer"/"vendor").
  if (!info.service) info.service = SERVICE;
  info.env = ENV;
  info.releaseVersion = RELEASE;
  return info;
});

// 2. Redact secrets / PII (mandatory, runs on every transport).
// Mutate `info` IN PLACE so winston's internal Symbol keys (level/message/splat)
// survive — redact() returns a fresh copy that would otherwise drop them.
const redactFormat = winston.format((info) => {
  const cleaned = redact(info);
  for (const k of Object.keys(info)) delete info[k];
  Object.assign(info, cleaned);
  return info;
});

const baseFormat = winston.format.combine(
  injectContext(),
  redactFormat(),
  winston.format.timestamp()
);

// Console: human-readable in dev, JSON in production.
const consoleFormat = ENV === 'production'
  ? winston.format.json()
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.printf((info) => {
        const ids = [info.requestId && `req=${info.requestId}`, info.userId && `user=${info.userId}`, info.orderId && `order=${info.orderId}`]
          .filter(Boolean).join(' ');
        const meta = Object.keys(info).filter((k) => ![
          'level', 'message', 'timestamp', 'service', 'env', 'releaseVersion',
          'requestId', 'userId', 'role', 'orderId',
        ].includes(k));
        const extra = meta.length ? ' ' + JSON.stringify(meta.reduce((a, k) => (a[k] = info[k], a), {})) : '';
        return `${info.level} ${info.message}${ids ? ' (' + ids + ')' : ''}${extra}`;
      })
    );

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
];

// Grafana Loki transport — added only when configured (sink-agnostic).
let lokiEnabled = false;
if (process.env.LOKI_URL) {
  try {
    const LokiTransport = require('winston-loki');
    transports.push(new LokiTransport({
      host: process.env.LOKI_URL,
      basicAuth: process.env.LOKI_USER && process.env.LOKI_API_KEY
        ? `${process.env.LOKI_USER}:${process.env.LOKI_API_KEY}`
        : undefined,
      // Low-cardinality labels only; requestId/userId/orderId live in the log
      // line (queryable via LogQL `| json`), NOT as labels.
      labels: { service: SERVICE, env: ENV },
      json: true,
      format: winston.format.json(),
      replaceTimestamp: true,
      batching: true,
      interval: 5,
      gracefulShutdown: true,
      onConnectionError: (err) => console.error('[LOKI] transport error:', err && err.message),
    }));
    lokiEnabled = true;
  } catch (err) {
    console.error('[LOKI] failed to initialize transport:', err.message);
  }
}

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: baseFormat,
  transports,
  exitOnError: false,
});

logger.lokiEnabled = lokiEnabled;

if (!lokiEnabled) {
  logger.warn('Loki transport disabled (LOKI_URL not set) — logs are console-only and will not persist.');
}

module.exports = logger;
