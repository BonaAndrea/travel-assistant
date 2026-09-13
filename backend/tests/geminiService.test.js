import { fromGeminiResponse, toGeminiMessages, toGeminiTools } from '../src/services/geminiService.js';

describe('Gemini adapter contract', () => {
  test('traduce immagini inline e tool nel formato Gemini', () => {
    const mapped = toGeminiMessages([
      { role: 'system', content: 'Istruzioni' },
      { role: 'user', content: [
        { type: 'text', text: 'Preferisco mare' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
      ] },
    ]);
    expect(mapped.systemInstruction.parts[0].text).toBe('Istruzioni');
    expect(mapped.contents[0].role).toBe('user');
    expect(mapped.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: 'abc' });
    expect(toGeminiTools([{ type: 'function', function: {
      name: 'update_requirements', description: 'Aggiorna', parameters: { type: 'object' },
    } }])).toEqual([{ functionDeclarations: [{
      name: 'update_requirements', description: 'Aggiorna', parameters: { type: 'object' },
    }] }]);
  });

  test('riconsegna testo e function call nel formato interno OpenAI-like', () => {
    const result = fromGeminiResponse({ candidates: [{ content: { parts: [
      { functionCall: { name: 'update_requirements', args: { country: 'Spagna' } }, thoughtSignature: 'opaque-signature' },
      { text: '<think>interno</think>Risposta' },
    ] } }] });
    expect(result.choices[0].message.content).toContain('Risposta');
    expect(result.choices[0].message.tool_calls[0].function).toEqual({
      name: 'update_requirements', arguments: '{"country":"Spagna"}',
    });
    expect(result.choices[0].message.tool_calls[0].thoughtSignature).toBe('opaque-signature');
    expect(toGeminiMessages([
      { role: 'assistant', content: '', tool_calls: result.choices[0].message.tool_calls },
    ]).contents[0].parts[0].thoughtSignature).toBe('opaque-signature');
    expect(toGeminiMessages([{ role: 'assistant', content: 'Risposta' }]).contents.at(-1).role).toBe('user');
  });
});
