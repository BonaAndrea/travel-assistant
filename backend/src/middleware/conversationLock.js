import { acquireConversationAdvisoryLock, ConversationLockTimeoutError } from '../services/conversationAdvisoryLock.js';

const locks = new Map();

function createProcessLockMiddleware(lockMap) {
  return async function conversationLock(req, res, next) {
    const key = String(req.params.id || '');
    const previous = lockMap.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    lockMap.set(key, chain);
    await previous;

    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
      if (lockMap.get(key) === chain) lockMap.delete(key);
    };
    res.once('finish', done);
    res.once('close', done);
    return next();
  };
}

/**
 * Usa advisory lock PostgreSQL in produzione e fallback process-local nei test
 * unitari senza database. L'integration runner attiva il percorso PostgreSQL.
 */
export function createConversationLockMiddleware(lockMap) {
  if (lockMap instanceof Map) return createProcessLockMiddleware(lockMap);
  if (process.env.NODE_ENV === 'test' && process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres') {
    return createProcessLockMiddleware(locks);
  }

  return async function distributedConversationLock(req, res, next) {
    const key = String(req.params.id || '');
    let release;
    try {
      release = await acquireConversationAdvisoryLock(key);
    } catch (error) {
      if (error instanceof ConversationLockTimeoutError) {
        return res.status(error.status).json({ code: error.code, error: error.message });
      }
      return next(error);
    }
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      void release().catch(() => {});
    };
    res.once('finish', done);
    res.once('close', done);
    return next();
  };
}
