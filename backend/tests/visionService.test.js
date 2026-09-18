import { jest } from '@jest/globals';

process.env.GROQ_API_KEY = 'vision-test-key';
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
jest.unstable_mockModule('groq-sdk', () => ({
  default: MockGroq,
  APIConnectionError: MockAPIConnectionError,
}));

const { analyzePreferenceImage, visionConfig } = await import('../src/services/visionService.js');

describe('analisi vision delle immagini preferenze', () => {
  beforeEach(() => jest.clearAllMocks());

  test('usa il modello vision configurato e normalizza i tag controllati', async () => {
    completionCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        description: 'Una spiaggia con mare e paesaggio naturale.',
        tags: ['mare', 'NATURA', 'volo', 'mare'],
      }) } }],
    });

    const result = await analyzePreferenceImage({
      buffer: Buffer.from('image'), mimeType: 'image/png',
    });

    expect(result).toEqual({
      status: 'completed',
      description: 'Una spiaggia con mare e paesaggio naturale.',
      tags: ['mare', 'natura'],
      reason: null,
    });
    expect(completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen/qwen3.6-27b',
    }));
    expect(completionCreate.mock.calls[0][0].response_format).toBeUndefined();
    expect(completionCreate.mock.calls[0][0].messages[0].content[1].image_url.url)
      .toMatch(/^data:image\/png;base64,/);
    expect(visionConfig).toMatchObject({ enabled: true, model: 'qwen/qwen3.6-27b', timeoutMs: 15000 });
  });

  test('usa metadata_only se l’output del modello non è strutturato', async () => {
    completionCreate.mockResolvedValue({ choices: [{ message: { content: 'non-json' } }] });

    await expect(analyzePreferenceImage({ buffer: Buffer.from('image'), mimeType: 'image/png' }))
      .resolves.toEqual({ status: 'metadata_only', description: null, tags: [], reason: 'invalid_model_output' });
  });

  test('usa metadata_only se il provider o il modello non risponde', async () => {
    const error = new Error('model qwen/qwen3.6-27b does not exist');
    error.status = 404;
    completionCreate.mockRejectedValue(error);

    await expect(analyzePreferenceImage({ buffer: Buffer.from('image'), mimeType: 'image/png' }))
      .resolves.toEqual({ status: 'metadata_only', description: null, tags: [], reason: 'vision_model_unavailable' });
  });

  test('usa metadata_only per un MIME non supportato senza chiamare Groq', async () => {
    await expect(analyzePreferenceImage({ buffer: Buffer.from('image'), mimeType: 'image/gif' }))
      .resolves.toEqual({ status: 'metadata_only', description: null, tags: [], reason: 'unsupported_image' });
    expect(completionCreate).not.toHaveBeenCalled();
  });

  test('accetta JSON vision racchiuso in code fence', async () => {
    completionCreate.mockResolvedValue({
      choices: [{ message: { content: '```json\\n{"description":"Chiesa riconoscibile","tags":["architettura"]}\\n```' } }],
    });
    await expect(analyzePreferenceImage({ buffer: Buffer.from('image'), mimeType: 'image/png' }))
      .resolves.toMatchObject({ status: 'completed', tags: ['architettura'] });
  });

  test('classifica un’immagine non decodificabile come invalid image', async () => {
    const error = new Error('invalid image data');
    error.status = 400;
    completionCreate.mockRejectedValue(error);
    await expect(analyzePreferenceImage({ buffer: Buffer.from('image'), mimeType: 'image/png' }))
      .resolves.toMatchObject({ status: 'metadata_only', reason: 'vision_invalid_image' });
  });
});
