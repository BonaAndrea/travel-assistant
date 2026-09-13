import { afterAll, expect, test } from '@jest/globals';
import { acquireConversationAdvisoryLock, closeConversationAdvisoryPool } from '../../src/services/conversationAdvisoryLock.js';

afterAll(async () => { await closeConversationAdvisoryPool(); });

test('PostgreSQL advisory lock serializza davvero due acquisizioni concorrenti', async () => {
  const firstRelease = await acquireConversationAdvisoryLock('integration-conversation', {
    timeoutMs: 2000, pollMs: 10,
  });
  let secondAcquired = false;
  const second = acquireConversationAdvisoryLock('integration-conversation', {
    timeoutMs: 2000, pollMs: 10,
  }).then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(secondAcquired).toBe(false);
  await firstRelease();
  const secondRelease = await second;
  expect(secondAcquired).toBe(true);
  await secondRelease();
});
