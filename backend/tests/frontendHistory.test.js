import { readFileSync } from 'node:fs';

const historyScript = readFileSync(new URL('../../frontend/history.js', import.meta.url), 'utf8');
const historyHtml = readFileSync(new URL('../../frontend/history.html', import.meta.url), 'utf8');
const chatHtml = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const style = readFileSync(new URL('../../frontend/style.css', import.meta.url), 'utf8');

test('history exposes the resume CTA inside the selected conversation detail', () => {
  expect(historyScript).toContain('chat.html?conversationId=${encodeURIComponent(conversation.id)}');
  expect(historyScript).toContain('Riprendi conversazione');
  expect(historyScript).toContain("const ACTIVE_CONVERSATION_KEY = 'activeItineraryConversationId'");
  expect(historyScript).toContain('localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversation.id)');
   expect(historyScript).toContain("const detailActions = element('div', { className: 'detail-actions history-detail-actions booking-detail-actions' })");
  expect(historyScript).toContain('detailActions.append(resumeLink, deleteButton)');
  expect(historyScript).toContain("text: 'Elimina conversazione'");
  expect(historyScript).toContain("method: 'DELETE'");
  expect(historyScript).toContain("const detailHeading = element('div', { className: 'history-detail-heading booking-detail-heading' })");
  expect(historyScript).toContain("const detailTitle = element('h2', { text: 'Dettaglio conversazione' })");
  expect(historyScript).toContain('detailHeading.append(detailTitle, detailActions)');
  expect(historyScript).not.toContain('item.append(button, resumeLink)');
});

test('chat accepts a conversation id from the history link', () => {
  expect(chatHtml).toContain("new URLSearchParams(window.location.search).get('conversationId')");
  expect(chatHtml).toContain('isConversationId(requestedConversationId)');
  expect(chatHtml).toContain('isConversationId(storedConversationId)');
});

test('history cards keep readable text and visible resume focus state', () => {
  expect(style).toContain('button.history-item{background:var(--surface);color:var(--petrol-dark)}');
  expect(style).toContain('.history-item small{color:var(--ink-soft)}');
  expect(style).toContain('.history-item:focus-visible,.history-resume:focus-visible');
  expect(style).toContain('.history-resume:hover,.history-resume:focus-visible');
  expect(style).toContain('.history-detail-heading{display:flex;align-items:center;justify-content:space-between');
  expect(style).toContain('.history-detail-actions .history-resume{min-height:48px');
  expect(style).toContain('.detail-actions{display:flex;align-items:center;justify-content:flex-end');
  expect(style).toContain('.history-detail-heading,.booking-detail-heading{flex-wrap:nowrap}');
});

test('history list keeps the card and CTA in one accessible list item', () => {
  expect(historyScript).toContain("const item = element('article', { className: 'history-entry' })");
  expect(historyScript).toContain("item.setAttribute('role', 'listitem')");
  expect(historyScript).toContain('item.append(button)');
});

test('mobile history opens a closable drawer with keyboard focus management', () => {
  expect(historyHtml).toContain('id="conversation-detail" class="card history-detail detail-drawer"');
  expect(historyHtml).toContain('aria-label="Dettaglio conversazione"');
  expect(historyHtml).toContain('tabindex="-1"');
  expect(historyScript).toContain('function closeDetail()');
  expect(historyScript).toContain("button.setAttribute('aria-label', 'Chiudi dettaglio conversazione')");
   expect(historyScript).toContain("const detailHeader = element('div', { className: 'history-detail-header booking-detail-header' })");
  expect(historyScript).toContain('detailHeader.append(detailHeading)');
  expect(historyScript).toContain("event.key === 'Escape'");
  expect(historyScript).toContain('detailTrigger = trigger || document.activeElement');
  expect(historyScript).toContain('detailTrigger.focus()');
  expect(style).toContain('.history-detail.is-open{transform:translateX(0);visibility:visible;opacity:1');
  expect(style).toContain('body.history-detail-open{overflow:hidden}');
  expect(style).toContain('.history-detail-header{position:sticky;top:0;z-index:5');
   expect(historyHtml).toContain('class="card history-detail detail-drawer"');
   expect(style).toContain('.detail-drawer .booking-detail-header{position:sticky;top:0;z-index:5');
   expect(style).toContain('.detail-drawer .booking-detail-actions{position:static;left:auto;right:auto;bottom:auto');
   expect(style).toContain('.detail-drawer .booking-detail-actions button,.detail-drawer .booking-detail-actions .history-resume,.detail-drawer .booking-detail-actions .history-delete{width:auto;min-width:0;flex:1 1 150px');
   expect(style).toContain('.detail-drawer.history-detail{padding-bottom:40px}');
});

test('history keeps the selected card persistent and aligns the desktop panels', () => {
  expect(historyHtml).toContain('class="history-list-panel"');
  expect(historyScript).toContain('let selectedConversationId = null');
  expect(historyScript).toContain('function setSelectedConversation(id)');
  expect(historyScript).toContain("item.classList.toggle('is-selected', selected)");
  expect(historyScript).toContain("item.setAttribute('aria-pressed', String(selected))");
  expect(historyScript).toContain('button.dataset.conversationId = conversation.id');
  expect(style).toContain('.history-item.is-selected{background:#f1f7f4;border-color:var(--coral)');
  expect(style).toContain('.history-list-panel #conversation-list{display:grid;gap:10px;align-content:start}');
  expect(style).toContain('@media (min-width:801px){.history-layout{grid-template-columns:minmax(280px,.85fr) minmax(0,1.5fr);align-items:start}');
});

test('history remains list-first without implicit detail selection', () => {
  expect(historyScript).toContain('let selectedConversationId = null');
  expect(historyScript).toContain('loadPage(1);');
  expect(historyScript).not.toContain('showDetail(conversation.id));');
  expect(historyHtml).toContain('Seleziona una conversazione');
});
