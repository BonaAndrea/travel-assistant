import { jest, test, expect } from '@jest/globals';

process.env.GROQ_API_KEY = 'fallback-test-key';
process.env.LLM_MAX_RETRIES = '0';

const groqCompletion = jest.fn().mockRejectedValue(Object.assign(new Error('provider unavailable'), { status: 503 }));
class MockGroq {
  constructor() {
    this.chat = { completions: { create: groqCompletion } };
  }
}

const geminiCompletion = jest.fn().mockResolvedValue({
  choices: [{ message: { content: "I've got all the details. Let's prepare the itinerary." } }],
});

class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
jest.unstable_mockModule('groq-sdk', () => ({
  default: MockGroq, APIConnectionError: MockAPIConnectionError,
  APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
}));
jest.unstable_mockModule('../src/services/geminiService.js', () => ({
  GEMINI_ENABLED: true,
  GEMINI_VISION_ENABLED: false,
  createDefaultGeminiCompletion: geminiCompletion,
}));

const { chatTurn } = await import('../src/services/llmService.js');

test('fallback Gemini mantiene l italiano nel flusso chat completo', async () => {
  const turn = await chatTurn(
    [{ role: 'user', content: 'Ho fornito tutti i dati, possiamo procedere?' }],
    { country: 'Spagna', destinationCity: 'Barcellona', budget: 2000 },
    'confirming',
  );

  expect(groqCompletion).toHaveBeenCalled();
  expect(geminiCompletion).toHaveBeenCalled();
  expect(turn.assistantMessage).toBe('Ho raccolto tutti i dati del viaggio. Confermi che vada bene così?');
  expect(turn.assistantMessage).not.toMatch(/\b(I've|the|details|prepare|itinerary)\b/i);
  expect(geminiCompletion.mock.calls[0][0].messages[0].content).toMatch(/italiano/i);
});
