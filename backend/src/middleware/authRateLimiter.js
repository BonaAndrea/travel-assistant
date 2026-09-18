import crypto from 'node:crypto';
import { metrics } from '../services/metrics.js';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_IP_MAX = 100;
const DEFAULT_ACCOUNT_MAX = 10;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} deve essere un intero positivo`);
  }
  return parsed;
}

export function authRateLimitConfig(env = process.env) {
  return {
    windowMs: positiveInteger(env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 'AUTH_RATE_LIMIT_WINDOW_MS'),
    ipMax: positiveInteger(env.AUTH_RATE_LIMIT_IP_MAX, DEFAULT_IP_MAX, 'AUTH_RATE_LIMIT_IP_MAX'),
    accountMax: positiveInteger(env.AUTH_RATE_LIMIT_ACCOUNT_MAX, DEFAULT_ACCOUNT_MAX, 'AUTH_RATE_LIMIT_ACCOUNT_MAX'),
  };
}

function accountKey(req) {
  const email = req.body?.email;
  if (typeof email !== 'string' || email.trim() === '') return null;
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function currentEntry(store, key, now, windowMs) {
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + windowMs };
    store.set(key, fresh);
    return fresh;
  }
  return entry;
}

function secondsUntil(resetAt, now) {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

function removeExpired(store, now) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}

/**
 * Limite fixed-window in memoria. L'account viene identificato tramite hash dell'email,
 * così il limiter non conserva indirizzi email in chiaro.
 */
export function createAuthRateLimiter(options = {}) {
  const config = options.config || authRateLimitConfig();
  const now = options.now || Date.now;
  const ipStore = new Map();
  const accountStore = new Map();
  let requestCount = 0;

  return function authRateLimiter(req, res, next) {
    const timestamp = now();
    requestCount += 1;
    if (requestCount % 1_000 === 0) {
      removeExpired(ipStore, timestamp);
      removeExpired(accountStore, timestamp);
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const ipEntry = currentEntry(ipStore, ip, timestamp, config.windowMs);
    const account = accountKey(req);
    const accountEntry = account
      ? currentEntry(accountStore, account, timestamp, config.windowMs)
      : null;

    const exceeded = [];
    if (ipEntry.count >= config.ipMax) exceeded.push(ipEntry);
    if (accountEntry && accountEntry.count >= config.accountMax) exceeded.push(accountEntry);

    if (exceeded.length > 0) {
      const retryAfter = secondsUntil(Math.max(...exceeded.map((entry) => entry.resetAt)), timestamp);
      metrics.increment('auth_rate_limit_blocked_total', {
        route: `${req.baseUrl || ''}${req.path || 'unknown'}`,
        reason: exceeded.length > 1 ? 'ip_and_account' : accountEntry && exceeded[0] === accountEntry ? 'account' : 'ip',
      });
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Troppe richieste di autenticazione, riprova più tardi',
        code: 'AUTH_RATE_LIMITED',
        retryAfter,
      });
    }

    ipEntry.count += 1;
    if (accountEntry) accountEntry.count += 1;
    return next();
  };
}
