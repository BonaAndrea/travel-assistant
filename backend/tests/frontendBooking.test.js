import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const bookingCode = html.slice(html.indexOf("        const btn = card.querySelector('.book-btn');"), html.indexOf('\n      });\n    }', html.indexOf("        const btn = card.querySelector('.book-btn');")));

function mount(api, storage = new Map()) {
  let click;
  const button = { disabled: false, addEventListener: (_, handler) => { click = handler; } };
  const status = { textContent: '' };
  vm.runInNewContext(bookingCode, {
    card: { querySelector: (selector) => selector === '.book-btn' ? button : Object.assign(status, { addEventListener() {} }), querySelectorAll: () => [] },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    ACTIVE_JOB_KEY: 'job', conversationId: 'conversation', choice: 'primary',
    option: {
      totalCost: 420,
      flights: { outbound: { destinationAirport: { iataCode: 'LIS', city: 'Lisbona' }, date: '2026-07-01' }, inbound: { date: '2026-07-03' } },
      hotel: { hotel: { name: 'Hotel Lisboa' } },
    },
    isAlternative: false,
    crypto: { randomUUID: () => 'stable-request-key' }, confirm: () => true, api,
  });
  return { click, button, status, storage };
}

test('retry after lost booking response reuses draft and key, including after refresh', async () => {
  const api = jest.fn()
    .mockResolvedValueOnce({ id: 'draft-1' })
    .mockRejectedValueOnce(new Error('Network connection lost'))
    .mockResolvedValueOnce({ booking: { status: 'confirmed' } });
  const first = mount(api);
  await first.click();
  expect(first.button.disabled).toBe(false);
  const refreshed = mount(api, first.storage);
  await refreshed.click();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/itineraries', '/bookings', '/bookings']);
  expect(api.mock.calls[2][1].body).toEqual(api.mock.calls[1][1].body);
  expect(refreshed.button.disabled).toBe(true);
  await refreshed.click();
  const completedRefresh = mount(api, first.storage);
  await completedRefresh.click();
  expect(completedRefresh.button.disabled).toBe(true);
  expect(api).toHaveBeenCalledTimes(3);
});

test('concurrent clicks submit only one booking operation', async () => {
  let finishDraft;
  const api = jest.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { finishDraft = resolve; }))
    .mockResolvedValueOnce({ booking: { status: 'confirmed' } });
  const page = mount(api);
  const firstClick = page.click();
  await page.click();
  expect(api).toHaveBeenCalledTimes(1);
  finishDraft({ id: 'draft-1' });
  await firstClick;
  expect(api).toHaveBeenCalledTimes(2);
  expect(page.button.disabled).toBe(true);
});

test('booking confirmation summarizes destination, total and final verification', async () => {
  const confirmations = [];
  let click;
  const button = { disabled: false, addEventListener: (_, handler) => { click = handler; } };
  const status = {};
  vm.runInNewContext(bookingCode, {
    card: { querySelector: (selector) => selector === '.book-btn' ? button : { ...status, addEventListener() {} }, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
    ACTIVE_JOB_KEY: 'job', conversationId: 'conversation', choice: 'primary',
    option: { totalCost: 420, flights: { outbound: { destinationAirport: { iataCode: 'LIS', city: 'Lisbona' }, date: '2026-07-01' }, inbound: { date: '2026-07-03' } } }, isAlternative: false,
    crypto: { randomUUID: () => 'stable-request-key' },
    confirm: (message) => { confirmations.push(message); return false; }, api: jest.fn(),
  });
  await click();
  expect(confirmations[0]).toContain('LIS');
  expect(confirmations[0]).toContain('420.00 €');
  expect(confirmations[0]).toContain('prezzo e disponibilità');
});

test('booking conflict exposes returned status and failure reason', async () => {
  const error = new Error('Disponibilità cambiata');
  error.payload = { booking: { status: 'partial_failed', failureReason: 'Hotel esaurito' } };
  const page = mount(jest.fn().mockResolvedValueOnce({ id: 'draft-1' }).mockRejectedValueOnce(error));
  await page.click();
  expect(page.status.textContent).toContain('partial_failed');
  expect(page.status.textContent).toContain('Hotel esaurito');
});

test('confirmed booking exposes a direct dashboard URL for the created booking', () => {
  expect(html).toContain('dashboard.html?bookingId=${encodeURIComponent(bookingId)}');
  expect(html).toContain('Apri prenotazione');
  expect(html).toContain('class="booking-confirmation"');
  expect(html).not.toContain('Il tuo viaggio è pronto.');
  expect(html).not.toContain('Vedi in Dashboard');
});
