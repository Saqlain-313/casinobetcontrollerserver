import { fetchCasinoData } from './matchApi/index.js';

// Every consumer of a casino table (bet validation, the 1s WebSocket poller and the
// REST endpoint) reads through this cache. Concurrent callers for the same table share
// one in-flight provider request, so provider load depends on the number of live
// tables, never on the number of users or bets.
const cache = new Map(); // eventName -> { at, value }
const inflight = new Map(); // eventName -> Promise
const failures = new Map(); // eventName -> { at, error }

// A failed refresh may fall back to data at most this old (ms)
const MAX_STALE_ON_ERROR_MS = 1500;
// Unknown / failing tables are not re-requested from the provider for this long (ms)
const FAILURE_BACKOFF_MS = 2000;
// Event names are put in the provider URL path, so only plain slugs are accepted
const EVENT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
// Bounds memory if callers pass many distinct names
const MAX_TRACKED_NAMES = 500;

export const getCasinoTable = (eventName, maxAgeMs = 500) => {
  if (typeof eventName !== 'string' || !EVENT_NAME_PATTERN.test(eventName)) {
    return Promise.reject(new Error('Invalid casino event name'));
  }

  const cached = cache.get(eventName);
  if (cached && Date.now() - cached.at <= maxAgeMs) {
    return Promise.resolve(cached.value);
  }

  const failed = failures.get(eventName);
  if (failed && Date.now() - failed.at < FAILURE_BACKOFF_MS) {
    return cached && Date.now() - cached.at <= MAX_STALE_ON_ERROR_MS
      ? Promise.resolve(cached.value)
      : Promise.reject(failed.error);
  }

  let pending = inflight.get(eventName);
  if (!pending) {
    pending = fetchCasinoData(eventName)
      .then((value) => {
        failures.delete(eventName);
        if (value?.success) {
          if (cache.size >= MAX_TRACKED_NAMES) cache.clear();
          cache.set(eventName, { at: Date.now(), value });
        }
        return value;
      })
      .catch((error) => {
        if (failures.size >= MAX_TRACKED_NAMES) failures.clear();
        failures.set(eventName, { at: Date.now(), error });
        if (cached && Date.now() - cached.at <= MAX_STALE_ON_ERROR_MS) {
          return cached.value;
        }
        throw error;
      })
      .finally(() => inflight.delete(eventName));
    inflight.set(eventName, pending);
  }
  return pending;
};
