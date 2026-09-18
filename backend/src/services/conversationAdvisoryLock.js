import pg from 'pg';

const { Pool } = pg;
const DEFAULT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 25;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  // Le connessioni idle non devono impedire lo shutdown di test/CLI.
  allowExitOnIdle: true,
});

function configuredTimeout(value = process.env.CONVERSATION_LOCK_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export class ConversationLockTimeoutError extends Error {
  constructor(timeoutMs) {
    super('La conversazione è occupata da un altro turno. Riprova tra poco.');
    this.name = 'ConversationLockTimeoutError';
    this.code = 'CONVERSATION_LOCK_TIMEOUT';
    this.status = 409;
    this.timeoutMs = timeoutMs;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Detiene un advisory lock PostgreSQL su una connessione dedicata fino al rilascio. */
export async function acquireConversationAdvisoryLock(key, {
  dbPool = pool, timeoutMs = configuredTimeout(), pollMs = POLL_INTERVAL_MS,
} = {}) {
  const client = await dbPool.connect();
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    while (Date.now() <= deadline) {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [String(key)],
      );
      if (result.rows[0]?.acquired) {
        acquired = true;
        let released = false;
        return async function release() {
          if (released) return;
          released = true;
          try {
            await client.query(
              'SELECT pg_advisory_unlock(hashtextextended($1, 0))', [String(key)],
            );
          } finally {
            client.release();
          }
        };
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new ConversationLockTimeoutError(timeoutMs);
  } catch (error) {
    if (!acquired) client.release();
    throw error;
  }
}

export function closeConversationAdvisoryPool() {
  return pool.end();
}
