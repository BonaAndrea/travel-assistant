import { DEFAULT_MODEL } from '../src/services/llmService.js';

describe('Groq model configuration', () => {
  test('usa un modello attualmente supportato da Groq', () => {
    expect(DEFAULT_MODEL).toBe('llama-3.3-70b-versatile');
  });
});
