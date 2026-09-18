import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import .*?from '\.\/api.js';/, '')
  .replace(/    init\(\);\s*$/, '');
const conversationId = '550e8400-e29b-41d4-a716-446655440000';
const requirements = { participants: 2, country: 'Spagna' };
const result = { requirementsSnapshot: requirements, primary: { status: 'ok' } };
const conversation = { state: { requirements, lastResult: result }, messages: [{ role: 'user', content: 'Spagna' }, { role: 'assistant', content: 'Confermi?' }] };

function mount(api, savedJob) {
  const storage = new Map([['activeItineraryConversationId', conversationId]]);
  if (savedJob) storage.set('activeItineraryGenerationJob', JSON.stringify(savedJob));
  const nodes = new Map();
  const messages = [];
  const renders = [];
  const timers = [];
  const context = vm.createContext({
    window: {},
    api, requireLogin: () => {}, logout: () => {},
    document: { hidden: false, querySelectorAll: () => [], getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, replaceChildren: () => { messages.length = 0; } });
      return nodes.get(id);
    } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {},
    crypto: { randomUUID: () => 'new-key' },
    recordMessage: (role, text) => messages.push({ role, content: text }),
    recordRender: value => renders.push(value),
  });
  vm.runInContext(script + '\nappendMessage = recordMessage; renderItinerary = recordRender;', context);
  return { init: () => context.init(), context, storage, messages, renders, timers: timers.filter((timer) => typeof timer === 'function'), nodes };
}

test('refresh restores transcript once and renders only authoritative current result', async () => {
  const api = jest.fn(async path => path.startsWith('/chat/') ? conversation : { job: { id: 'job-1', conversationId, status: 'completed', result } });
  const page = mount(api, { id: 'job-1', conversationId, status: 'completed' });
  await page.init();
  await page.init();
  expect(page.messages).toEqual(conversation.messages);
  expect(page.renders).toEqual([result, result, result]);
});

test('lost creation response retries persisted key without duplicating messages', async () => {
  let attempts = 0;
  const api = jest.fn(async (path) => {
    if (path.startsWith('/chat/')) return conversation;
    if (path === '/itinerary-jobs') {
      if (++attempts === 1) throw new Error('network');
      return { job: { id: 'job-1', status: 'queued' } };
    }
    return { job: { id: 'job-1', conversationId, status: 'completed', result } };
  });
  const page = mount(api, { conversationId, idempotencyKey: 'persisted-key', status: 'creating', requirementsSnapshot: requirements });
  await page.init();
  await page.timers.find((timer) => typeof timer === 'function')?.();
  // Timer callbacks schedule an async operation; drain its promise continuations.
  await new Promise(resolve => setImmediate(resolve));
  const creates = api.mock.calls.filter(([path]) => path === '/itinerary-jobs');
  expect(creates).toHaveLength(2);
  expect(creates.map(([, options]) => options.body.idempotencyKey)).toEqual(['persisted-key', 'persisted-key']);
  expect(page.messages).toEqual(conversation.messages);
  expect(page.renders).toEqual([result]);
});

test('changed requirements discard persisted obsolete job before polling', async () => {
  const api = jest.fn(async () => conversation);
  const page = mount(api, { id: 'old-job', conversationId, requirementsSnapshot: { ...requirements, participants: 1 } });
  await page.init();
  expect(api).toHaveBeenCalledTimes(2);
  expect(page.renders).toEqual([null]);
  expect(page.storage.has('activeItineraryGenerationJob')).toBe(false);
});

test('completed stale result is hidden when conversation invalidates proposal', async () => {
  const api = jest.fn(async path => path.startsWith('/chat/')
    ? { ...conversation, state: { requirements } }
    : { job: { id: 'old-job', conversationId, status: 'completed', result } });
  const page = mount(api, { id: 'old-job', conversationId });
  await page.init();
  expect(page.renders).toEqual([null]);
});

test('conversation restore failure retries without creating another conversation', async () => {
  const api = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(conversation);
  const page = mount(api);
  await page.init();
  expect(page.nodes.get('send-btn').disabled).toBe(false);
  await page.timers.find((timer) => typeof timer === 'function')?.();
  expect(page.messages).toEqual(conversation.messages);
  expect(page.nodes.get('send-btn').disabled).toBe(false);
  expect(api.mock.calls.map(([path]) => path)).toEqual([`/chat/conversations/${conversationId}`, `/chat/conversations/${conversationId}`]);
});

test('response from a poll superseded by a new chat turn cannot restore old results', async () => {
  let finishPoll;
  const api = jest.fn(() => new Promise(resolve => { finishPoll = resolve; }));
  const page = mount(api);
  const pending = page.context.pollGenerationJob('old-job');
  vm.runInContext('generationVersion += 1;', page.context);
  finishPoll({ job: { id: 'old-job', status: 'completed', result } });
  await pending;
  expect(page.renders).toEqual([]);
  expect(page.storage.has('activeItineraryGenerationJob')).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
});

test('requirements comparison ignores object key ordering', () => {
  const page = mount(jest.fn());
  expect(page.context.requirementsMatch({ country: 'Spagna', participants: 2 }, requirements)).toBe(true);
});
