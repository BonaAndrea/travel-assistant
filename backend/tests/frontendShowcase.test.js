import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../../frontend/chat.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const style = readFileSync(new URL('../../frontend/style.css', import.meta.url), 'utf8');

test('chat showcase keeps the demo journey and actionable recovery controls', () => {
  expect(chat).toContain('chat-shell');
  expect(chat).toContain('id="chat-log"');
  expect(chat).toContain('id="chat-retry-btn"');
  expect(chat).toContain('id="generation-retry-btn"');
  expect(chat).toContain('setGenerationFeedback');
  expect(chat).toContain('function showGenerationTransition()');
  expect(chat).toContain('function setJourneyStep(currentIndex)');
  expect(chat).toContain('const historicalIssue = conversation.state?.generationIssue');
  expect(chat).toContain('const isDuplicateIssue = historicalIssue');
  expect(chat).toContain('hideMessage: functionalFailure');
  expect(chat).toContain('setJourneyStep(1);');
  expect(chat).toContain('Avvio generazione itinerario');
  expect(chat).toContain('Sto passando dalla conversazione alla generazione');
  expect(chat).toContain('setJourneyStep(2);');
  expect(chat).toContain('const labels = { queued:');
  expect(chat).toContain('clearChatCooldown();');
  expect(chat).toContain('functionalFailure = false');
  expect(chat).toContain("toggleAttribute('hidden', functionalFailure)");
  expect(chat).toContain('generation-progress');
  expect(chat).toContain('hidden = functionalFailure');
  expect(chat).toContain('syncComposerAvailability();\n        return;');
  expect(chat).toContain('cooldownUntil = 0;');
  expect(chat).not.toContain("document.getElementById('chat-retry-btn').hidden = true;");
  expect(chat).toContain('function generationIssueMessage(issue)');
  expect(chat).toContain('function renderGenerationIssueMessage(issue)');
  expect(chat).toContain('**Richiesta originale**');
  expect(chat).toContain('**Perché non funziona**');
  expect(chat).toContain('**Alternative disponibili**');
  expect(chat).toContain('const seenReturnDays = new Set()');
  expect(chat).toContain('if (outboundIsoDay && isoDay <= outboundIsoDay) return false;');
  expect(chat).toContain('seenReturnDays.has(isoDay)');
  expect(chat).toContain('durata risultante');
  expect(chat).toContain('Partenza usata:');
  expect(chat).toContain('durata: ${duration} giorni');
  expect(chat).toContain('ritorno atteso:');
  expect(chat).toContain('Alternative disponibili nel catalogo');
});

test('README documents the authenticated demo path and viewport evidence', () => {
  expect(readme).toContain('Percorso demo showcase');
  expect(readme).toContain('Matrice browser/viewport verificata');
  expect(readme).toContain('non esistono bypass');
  expect(readme).toContain('Browser interattivo reale end-to-end');
});

test('mobile hardening remains present for zoom, touch, motion and drawers', () => {
  expect(chat).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  expect(chat).toContain('aria-live="assertive"');
  expect(style).toContain('@media (max-width:360px)');
  expect(style).toContain('env(safe-area-inset-bottom)');
  expect(style).toContain('@media (prefers-reduced-motion:reduce)');
  expect(style).toContain('.detail-drawer.is-open');
  expect(style).not.toContain('user-scalable=no');
});

test('chat feedback distinguishes in-flight, lock, cooldown and retry states', () => {
  expect(chat).toContain('id="chat-send-status"');
  expect(chat).toContain('Richiesta in corso: attendo la risposta dell’assistente.');
  expect(chat).toContain("CONVERSATION_LOCK_TIMEOUT");
  expect(chat).toContain("error?.status === 429");
  expect(chat).toContain("error?.payload?.code === 'GROQ_CIRCUIT_OPEN'");
  expect(chat).toContain('function providerCooldownMessage(seconds)');
  expect(chat).toContain('Limite temporaneo del provider: riprova tra');
  expect(chat).toContain('Non è un blocco locale');
  expect(chat).toContain("cooldownKind: 'provider'");
  expect(chat).toContain('il retry non partirà automaticamente');
  expect(chat).toContain('send({ retry: true })');
  expect(chat).toContain('if (!retry) appendMessage(\'user\', text);');
  expect(chat).toContain('function sanitizeAssistantText(text)');
  expect(chat).toContain('<(think|analysis|reasoning)\\b');
  expect(chat).toContain("if (value == null || !String(value).trim()) return '';");
  expect(chat).toContain("media?.author || 'Fonte'");
  expect(chat).toContain('if (!data.retryable && !(returnChangeIntent && !requirementsChanged)) {');
});

test('chat cooldown and image turns stay actionable and privacy-safe', () => {
  expect(chat).toContain('id="chat-cooldown-progress"');
  expect(chat).toContain('id="chat-cooldown-label"');
  expect(chat).toContain('restoreCooldown();');
  expect(chat).toContain("document.addEventListener?.('visibilitychange'");
  expect(chat).toContain('Immagine caricata, analisi non eseguita');
  expect(chat).toContain('Immagine usata nel messaggio');
  expect(chat).toContain('Immagine ricevuta, analisi vision rimandata');
  expect(chat).toContain("entry.visionStatus === 'deferred'");
  expect(chat).toContain("entry.visionStatus === 'fallback'");
  expect(chat).toContain("entry.status === 'uploaded' && !entry.visionStatus");
  expect(chat).not.toContain('Analisi vision non attiva');
  expect(chat).toContain("data.code === 'GROQ_CIRCUIT_OPEN' ? 'deferred' : 'fallback'");
  expect(chat).toContain('Number(data.retryAfterMs || 0) / 1000');
  expect(chat).toContain('Il provider non ha indicato un tempo di attesa. Puoi riprovare ora.');
  expect(chat).not.toContain("Number(data.retryAfterMs || 0) / 1000 || 30");
  expect(chat).toContain('Suggerimento vision (non confermato)');
  expect(chat).toContain('analysis.extractedPreferences');
  expect(chat).toContain('entry.turn?.remove();');
});

test('image attachment is promoted from composer pending state only on send', () => {
  expect(chat).toContain('async function commitPendingImages()');
  expect(chat).toContain('await commitPendingImages();');
  expect(chat).toContain('if (!retry) appendMessage(\'user\', text);');
  expect(chat).toContain('entry.uploadPromise = uploadPreferenceImage(entry);');
  expect(chat).toContain('const retryImageIds = retry ? lastSentImageIds : imageIds;');
});

test('cooldown blocks the whole active composer and exposes request editing', () => {
  expect(chat).toContain('function syncComposerAvailability()');
  expect(chat).toContain('input.disabled = !initialized || blocked;');
  expect(chat).toContain('sending || cooldownUntil > Date.now()');
  expect(chat).toContain('id="generation-edit-btn"');
  expect(chat).toContain('Modifica la richiesta nel campo messaggio');
  expect(chat).toContain('setChatFeedback();');
});

test('first image selection initializes one conversation and supports image-only send', () => {
  expect(chat).toContain('async function ensureConversation()');
  expect(chat).toContain('conversationPromise = api(\'/chat/conversations\'');
  expect(chat).toContain('await ensureConversation();');
  expect(chat).toContain('Vorrei usare questa immagine come ispirazione per il viaggio.');
  expect(chat).toContain('const hasImage = preferenceImages.some');
  expect(chat).toContain('if (err.status === 404 && conversationId)');
  expect(chat).toContain('initialized = true;');
  expect(chat).toContain('requirementCorrectionPending');
  expect(chat).toContain('returnChangeIntent');
  expect(chat).toContain('Non ho aggiornato la data di ritorno');
  expect(chat).toContain('data.generationReady && !requirementCorrectionPending');
  expect(chat).toContain('function requirementsConfirmationMessage(requirements, fallback)');
  expect(chat).toContain('**Riepilogo aggiornato**');
  expect(chat).toContain('const destination = requirements.destinationCity || requirements.destinationAirport || requirements.country || \'da definire\';');
  expect(chat).toContain('- Partecipanti: ${requirements.participants || \'da definire\'}');
  expect(chat).toContain('- Budget totale: ${requirements.budget || \'da definire\'}€');
  expect(chat).toContain('- Preferenze: ${preferences}');
  expect(chat).toContain('Confermi questi nuovi requisiti?');
  expect(chat).toContain('requirementsConfirmationMessage(data.requirements, data.reply)');
  expect(chat).toContain('data.phase === \'confirming\' && !data.generationReady && data.requirements');
  expect(chat).toContain("shareControls.hidden = localStorage.getItem(VOICE_ENABLED_KEY) !== 'true';");
});

test('stale conversation IDs are replaced only for 404 upload failures', () => {
  expect(chat).toContain('CONVERSATION_ID_PATTERN');
  expect(chat).toContain('invalidateConversation(conversationId);');
  expect(chat).toContain('error.status === 404 && !entry.retriedStaleConversation');
  expect(chat).toContain('entry.retriedStaleConversation = true;');
  expect(chat).toContain('conversationPromise = null;');
  expect(chat).not.toContain('error.status === 401 && !entry.retriedStaleConversation');
});
