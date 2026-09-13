import { ConversationLockTimeoutError, acquireConversationAdvisoryLock } from '../src/services/conversationAdvisoryLock.js';

describe('advisory lock conversazionale', () => {
  test('acquisisce e rilascia il lock sulla stessa connessione', async () => {
    const queries = [];
    const client = {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ acquired: !sql.includes('unlock') }] };
      },
      release: () => { queries.push('release'); },
    };
    const release = await acquireConversationAdvisoryLock('conversation-1', {
      dbPool: { connect: async () => client }, pollMs: 1,
    });
    await release();
    expect(queries[0]).toContain('pg_try_advisory_lock');
    expect(queries[1]).toContain('pg_advisory_unlock');
    expect(queries.at(-1)).toBe('release');
  });

  test('restituisce timeout senza lasciare la connessione occupata', async () => {
    let released = false;
    await expect(acquireConversationAdvisoryLock('busy', {
      dbPool: {
        connect: async () => ({
          query: async () => ({ rows: [{ acquired: false }] }),
          release: () => { released = true; },
        }),
      }, timeoutMs: 2, pollMs: 1,
    })).rejects.toBeInstanceOf(ConversationLockTimeoutError);
    expect(released).toBe(true);
  });
});
