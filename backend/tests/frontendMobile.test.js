import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const chatHtml = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const style = readFileSync(new URL('../../frontend/style.css', import.meta.url), 'utf8');

test('mobile login keeps the auth form immediately available above the fold', () => {
  expect(indexHtml).toContain('class="auth-visual"');
  expect(indexHtml).toContain('id="login-form" class="card"');
  expect(style).toContain('body.auth-page-body{padding:10px 14px 30px}');
  expect(style).toContain('.auth-visual{min-height:0;padding:12px 16px');
  expect(style).toContain('.auth-visual>div:first-of-type{position:relative;z-index:1;margin-top:28px}');
  expect(style).toContain('.auth-visual h1{margin:0 0 7px');
  expect(style).toContain('.auth-forms .card{padding:17px 18px}');
  expect(style).toContain('body.auth-page-body{display:flex;flex-direction:column;min-height:100dvh;min-height:100svh');
  expect(style).toContain('.auth-page{display:flex;flex:1 1 auto;min-height:calc(100dvh');
  expect(style).toContain('.auth-layout{display:flex;flex:1 1 auto;flex-direction:column');
  expect(style).toContain('body.auth-page-body .auth-forms{flex:0 0 auto}');
  expect(style).toContain('.auth-page-body .auth-forms .card{flex:0 0 auto}');
  expect(style).toContain('.auth-page-body .auth-visual{flex:1 1 auto;min-height:clamp(190px,40dvh,420px)}');
  expect(style).toContain('.auth-page-body .auth-visual{min-height:clamp(160px,34dvh,300px)}');
  expect(style).toContain('.auth-page{flex:0 1 auto;min-height:0}');
  expect(style).toContain('.auth-layout{flex:0 1 auto}');
  expect(style).toContain('.auth-forms .card{flex:0 0 auto;min-height:0}');
  expect(style).toContain('body.auth-page-body,.auth-page,.auth-layout,.auth-visual,.auth-forms,.auth-forms .card{width:100%;max-width:100%;min-width:0}');
  expect(style).toContain('.auth-visual h1,.auth-visual p,.auth-visual .brand-lockup{max-width:100%;min-width:0;overflow-wrap:anywhere}');
  expect(style).toContain('@media (max-width:360px){.auth-visual h1{font-size:clamp(1.9rem,9vw,2.35rem)}');
});

test('mobile chat prioritizes the log and composer without removing the chat controls', () => {
  expect(chatHtml).toContain('id="chat-log" class="chat-log"');
  expect(chatHtml).toContain('class="chat-composer"');
  expect(chatHtml).toContain('id="chat-input"');
  expect(style).toContain('body.chat-page{padding:10px 14px 30px}');
  expect(style).toContain('.chat-page .page-intro{display:none}');
  expect(style).toContain('.chat-page .chat-log{height:clamp(160px,30vh,260px);min-height:140px');
  expect(chatHtml).toContain('function syncVisualViewport()');
  expect(chatHtml).toContain("window.visualViewport.addEventListener('resize', syncVisualViewport)");
  expect(style).toContain('body.chat-page{min-height:var(--visual-viewport-height,100dvh)');
  expect(style).toContain('.chat-page main{display:flex;flex:1 1 auto;min-height:0');
  expect(style).toContain('.chat-page .chat-log{flex:1 1 auto;min-height:0;height:auto');
  expect(style).toContain('.chat-page .chat-composer{flex:0 0 auto');
});

test('mobile chat keeps transcript scrolling inside a bounded shell in portrait and landscape', () => {
  expect(style).toContain('.chat-page .chat-shell{display:grid;grid-template-rows:auto minmax(0,1fr) auto auto auto;flex:0 0 auto;height:clamp(220px,calc(100svh - 160px),720px);height:clamp(220px,calc(var(--visual-viewport-height,100dvh) - 160px),720px);max-height:calc(100svh - 24px);max-height:calc(var(--visual-viewport-height,100dvh) - 24px);min-height:0;overflow:hidden}');
  expect(style).toContain('.chat-page .chat-log{flex:1 1 0;min-height:0;height:auto;max-height:none;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain');
  expect(style).toContain('.chat-page .chat-composer,.chat-page .composer-status,.chat-page .image-preferences{flex:0 0 auto}');
  expect(style).toContain('@media (max-width:800px) and (orientation:landscape){');
  expect(style).toContain('.chat-page .chat-shell{height:clamp(200px,calc(100svh - 108px),420px);height:clamp(200px,calc(var(--visual-viewport-height,100dvh) - 108px),420px)}');
  expect(style).toContain('.chat-log{height:clamp(260px,52vh,530px);min-height:220px;overflow-y:auto;');
});

test('new chat action is visible, accessible and resets only the active conversation state', () => {
  expect(chatHtml).toContain('id="new-chat-btn" class="new-chat-button" type="button">Nuova chat</button>');
  expect(chatHtml).toContain("document.getElementById('new-chat-btn').addEventListener('click', startNewConversation)");
  expect(chatHtml).toContain('localStorage.removeItem(ACTIVE_CONVERSATION_KEY)');
  expect(chatHtml).toContain('window.history.replaceState({}, \'\', \'chat.html\')');
  expect(chatHtml).toContain('preferenceImages.splice(0)');
  expect(chatHtml).toContain('clearChatCooldown()');
  expect(chatHtml).toContain('renderOverlapWarning(null);');
  expect(style).toContain('.new-chat-button{min-height:48px');
  expect(style).toContain('.new-chat-button:focus-visible');
  expect(style).toContain('.chat-header{display:flex');
  expect(style).toContain('.chat-page .booking-confirmation{align-items:stretch;flex-direction:column');
  expect(chatHtml).toContain('id="chat-overlap-warning"');
  expect(chatHtml).toContain('Modifica date');
  expect(chatHtml).toContain('Continua comunque');
  expect(chatHtml).toContain('function renderOverlapWarning(payload)');
  expect(chatHtml).toContain('renderOverlapWarning(data);');
  expect(style).toContain('.chat-page .chat-overlap-warning{flex-direction:column');
  expect(style).toContain('.chat-overlap-warning[hidden]{display:none}');
});

test('chat image preferences expose accessible responsive upload controls', () => {
  expect(chatHtml).toContain('id="preference-images"');
  expect(chatHtml).toContain('accept="image/jpeg,image/png,image/webp"');
  expect(chatHtml).toContain('MAX_PREFERENCE_IMAGES = 4');
  expect(chatHtml).toContain('MAX_PREFERENCE_IMAGE_SIZE = 5 * 1024 * 1024');
  expect(chatHtml).toContain('Rimuovi');
  expect(style).toContain('.image-previews{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))');
  expect(style).toContain('@media (max-width:600px){.image-preferences-heading{display:block}');
});
