import { EventEmitter } from 'node:events';
import { createConversationLockMiddleware } from '../src/middleware/conversationLock.js';

function response() {
  const res = new EventEmitter();
  res.once = res.once.bind(res);
  return res;
}

describe('lock dei turni conversazionali', () => {
  test('serializza richieste della stessa conversazione e lascia correre chiavi diverse', async () => {
    const middleware = createConversationLockMiddleware(new Map());
    const firstResponse = response();
    let firstNext;
    const first = middleware({ params: { id: 'same' } }, firstResponse, () => { firstNext = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstNext).toBe(true);

    let secondNext = false;
    const secondResponse = response();
    const second = middleware({ params: { id: 'same' } }, secondResponse, () => { secondNext = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondNext).toBe(false);

    let otherNext = false;
    const otherResponse = response();
    const other = middleware({ params: { id: 'other' } }, otherResponse, () => { otherNext = true; });
    await other;
    expect(otherNext).toBe(true);

    firstResponse.emit('finish');
    await second;
    expect(secondNext).toBe(true);
    secondResponse.emit('finish');
    otherResponse.emit('finish');
    await first;
  });
});
