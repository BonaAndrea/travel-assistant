import { readFileSync } from 'node:fs';

const chatHtml = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const apiJs = readFileSync(new URL('../../frontend/api.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../../frontend/style.css', import.meta.url), 'utf8');

test('chat uploads each accepted preference image through the backend contract', () => {
  expect(chatHtml).toContain("apiFormData(`/chat/conversations/${conversationId}/preferences/images`, { file: entry.file })");
  expect(chatHtml).toContain('preferences/images/${encodeURIComponent(entry.id)}');
  expect(apiJs).toContain('export async function apiFormData');
  expect(apiJs).toContain('formData.append(field, file)');
});

test('scarta un conversationId stale non UUID prima dell upload', () => {
  expect(chatHtml).toContain('const CONVERSATION_ID_PATTERN =');
  expect(chatHtml).toContain('localStorage.removeItem(ACTIVE_CONVERSATION_KEY)');
  expect(chatHtml).toContain('isConversationId(requestedConversationId)');
});

test('image preference UI exposes validation, progress states and mobile sizing', () => {
  expect(chatHtml).toContain('disabled aria-describedby="image-preferences-help image-preferences-status"');
  expect(chatHtml).toContain("entry.status === 'uploading' ? 'Caricamento...'");
  expect(chatHtml).toContain("entry.status === 'uploaded' ? 'Caricata'");
  expect(style).toContain('.image-preview-state{display:block');
  expect(style).toContain('.image-preview-remove{min-height:44px}');
});

test('image upload is presented as a compact accessible composer attachment control', () => {
  expect(chatHtml).toContain('class="image-attach-button"');
  expect(chatHtml).toContain('title="Allega immagini"');
  expect(chatHtml).toContain('<span class="sr-only">Allega immagini</span>');
  expect(chatHtml).not.toContain('Ispirazione visiva');
  expect(style).toContain('.chat-composer{grid-template-columns:auto minmax(0,1fr) auto');
  expect(style).toContain('.image-attach-button{display:inline-flex');
});
