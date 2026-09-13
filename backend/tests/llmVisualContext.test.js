import { jest } from '@jest/globals';

process.env.GROQ_API_KEY = 'visual-test-key';
process.env.GROQ_VISION_ENABLED = 'true';
process.env.GROQ_VISION_FREE_TIER_CONFIRMED = 'true';
process.env.GROQ_VISION_MODEL = 'qwen/qwen3.6-27b';

const completionCreate = jest.fn();
class MockGroq {
  constructor() {
    this.chat = { completions: { create: completionCreate } };
  }
}
class MockAPIConnectionError extends Error {}
class MockAPIConnectionTimeoutError extends Error {}
jest.unstable_mockModule('groq-sdk', () => ({
  default: MockGroq,
  APIConnectionError: MockAPIConnectionError,
  APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
}));

const { chatTurn } = await import('../src/services/llmService.js');

test('include gli allegati espliciti nel turno visuale senza trasformarli in requisiti', async () => {
  completionCreate.mockResolvedValue({
    choices: [{ message: { content: 'Vedo un luogo da confermare.' } }],
  });

  await chatTurn(
    [{ role: 'user', content: 'Che luogo potrebbe essere?' }],
    {},
    'collecting',
    [{ analysisStatus: 'completed', description: 'Architettura religiosa', tags: ['architettura'] }],
    [{ id: 'image-1', mimeType: 'image/png', buffer: Buffer.from('image') }],
  );

  const request = completionCreate.mock.calls[0][0];
  expect(request.model).toBe('qwen/qwen3.6-27b');
  expect(request.messages.at(-1).content).toEqual([
    { type: 'text', text: 'Che luogo potrebbe essere?' },
    { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
  ]);
  expect(request.messages[0].content).toMatch(/non trattarli come requisiti/i);
});

test('non accetta dal solo modello vision un requisito non scritto dall’utente', async () => {
  completionCreate.mockResolvedValueOnce({
    choices: [{ message: {
      content: '<think>La foto sembra in Spagna</think>Potrebbe piacerti la Spagna.',
      tool_calls: [{ function: { name: 'update_requirements', arguments: JSON.stringify({ country: 'Spagna' }) } }],
    } }],
  });

  const turn = await chatTurn(
    [{ role: 'user', content: 'Che destinazione suggerisce questa immagine?' }],
    {}, 'collecting', [], [{ id: 'image-2', mimeType: 'image/png', buffer: Buffer.from('image') }],
  );

  expect(turn.updatedFields).toEqual({});
  expect(turn.assistantMessage).toBe('Potrebbe piacerti la Spagna.');
});
