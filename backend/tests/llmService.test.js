import {
  buildSystemPrompt, DEFAULT_MODEL, LLM_RESILIENCE_CONFIG, LLM_TIMEOUT_MS, sanitizeLlmOutput,
  CHAT_VISION_MAX_RETRIES, enforceItalianAssistantMessage,
} from '../src/services/llmService.js';

describe('Groq model configuration', () => {
  test('usa un modello attualmente supportato da Groq', () => {
    expect(DEFAULT_MODEL).toBe('llama-3.3-70b-versatile');
  });

  test('espone una configurazione runtime sicura per timeout, retry e circuito', () => {
    expect(LLM_TIMEOUT_MS).toBe(10000);
    expect(LLM_RESILIENCE_CONFIG).toEqual({
      maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2000,
      failureThreshold: 3, cooldownMs: 30000,
    });
    expect(CHAT_VISION_MAX_RETRIES).toBe(0);
  });

  test('inserisce descrizione e tag vision come segnali non confermati', () => {
    const prompt = buildSystemPrompt({}, 'collecting', [{
      analysisStatus: 'completed',
      description: 'Una spiaggia con mare aperto.',
      tags: ['mare', 'relax'],
    }]);

    expect(prompt).toContain('Una spiaggia con mare aperto.');
    expect(prompt).toContain('mare');
    expect(prompt).toMatch(/segnali non confermati/i);
    expect(prompt).toMatch(/non trattarli come requisiti/i);
  });

  test('inserisce il vincolo dell’ultimo fallimento e vieta il retry cieco', () => {
    const prompt = buildSystemPrompt({ durationDays: 7 }, 'confirming', [], {
      errorCode: 'no_return',
      message: 'Nessun ritorno compatibile con 7 giorni.',
      alternatives: [{ availableReturnDate: '2026-07-12T00:00:00.000Z' }],
    });

    expect(prompt).toContain('Nessun ritorno compatibile con 7 giorni.');
    expect(prompt).toContain('2026-07-12T00:00:00.000Z');
    expect(prompt).toMatch(/non avviare una nuova generazione/i);
    expect(prompt).toMatch(/quale requisito.*modificare/i);
  });

  test('rimuove sempre i blocchi di ragionamento dal testo mostrato', () => {
    expect(sanitizeLlmOutput('<think>segreto</think>Risposta utile')).toBe('Risposta utile');
    expect(sanitizeLlmOutput('Prima<analysis>interno')).toBe('Prima');
  });

  test('impedisce che una risposta inglese del fallback raggiunga l utente', () => {
    expect(enforceItalianAssistantMessage("I've got all the details. Let's prepare the itinerary.", {
      phase: 'confirming',
    })).toBe('Ho raccolto tutti i dati del viaggio. Confermi che vada bene così?');
  });
});
