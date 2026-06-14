// Request-scoped correlation context using AsyncLocalStorage.
// Every log line emitted during a request automatically inherits the
// requestId / userId / role / orderId stored here — no manual threading.
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/** Run `fn` with a fresh correlation context (a shallow copy of `context`). */
function runWithContext(context, fn) {
  return storage.run({ ...context }, fn);
}

/** Get the current request context, or an empty object outside a request. */
function getContext() {
  return storage.getStore() || {};
}

/**
 * Merge `patch` into the active context (e.g. attach userId once auth resolves,
 * or orderId once a handler knows which order it's touching). No-op if called
 * outside a request scope.
 */
function setContext(patch) {
  const store = storage.getStore();
  if (store && patch) Object.assign(store, patch);
}

module.exports = { storage, runWithContext, getContext, setContext };
