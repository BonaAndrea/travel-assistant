import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../../frontend/api.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../../frontend/dashboard.html', import.meta.url), 'utf8');

test('expired protected sessions redirect once and chat retries stop', () => {
  expect(api).toContain("window.location.replace('index.html?session=expired')");
  expect(api).toContain('sessionExpired: true');
  expect(chat.match(/if \(err\.sessionExpired\) return;/g)).toHaveLength(4);
  expect(index).toContain('La sessione è scaduta. Accedi di nuovo.');
});

test('auth selector uses simple pressed buttons instead of incomplete tab semantics', () => {
  expect(index).toContain('class="auth-mode" role="group"');
  expect(index).toContain('aria-pressed="true"');
  expect(index).not.toContain('role="tab"');
  expect(index).not.toContain('aria-selected');
});

test('media URLs are restricted and itinerary fields are escaped', () => {
  for (const source of [chat, dashboard]) {
    expect(source).toContain("['http:', 'https:'].includes(url.protocol)");
    expect(source).toContain('escapeHtml(imageUrl)');
  }
  expect(chat).toContain('escapeHtml(a.name)');
  expect(chat).toContain('escapeHtml(option.hotel.hotel.name)');
  expect(dashboard).toContain('escapeHtml(statusLabel(booking.status))');
});
