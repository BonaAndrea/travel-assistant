/**
 * Adapter REST opzionale per Gemini. Restituisce il formato OpenAI-like usato
 * internamente dal servizio LLM, così il provider resta invisibile alle route.
 * Non richiede un SDK aggiuntivo: Node 20 espone fetch nativamente.
 */
import { createLlmResilience, llmErrorFields, logLlmEvent } from './llmResilience.js';

const enabled = process.env.GEMINI_ENABLED === 'true'
  && Boolean(process.env.GEMINI_API_KEY)
  && process.env.GEMINI_FREE_TIER_CONFIRMED === 'true';
const visionEnabled = enabled && process.env.GEMINI_VISION_ENABLED === 'true';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
const timeoutMs = Number.isSafeInteger(Number(process.env.GEMINI_TIMEOUT_MS))
  && Number(process.env.GEMINI_TIMEOUT_MS) > 0 ? Number(process.env.GEMINI_TIMEOUT_MS) : 10000;
const maxRetries = Number.isSafeInteger(Number(process.env.GEMINI_MAX_RETRIES))
  && Number(process.env.GEMINI_MAX_RETRIES) >= 0 ? Number(process.env.GEMINI_MAX_RETRIES) : 0;

export const GEMINI_ENABLED = enabled;
export const GEMINI_VISION_ENABLED = visionEnabled;
export const GEMINI_MODEL = model;
export function getGeminiModelCandidates(configuredModel = model) {
  // Un modello configurato può essere ritirato dal provider. Manteniamo un
  // fallback stabile per non rendere indisponibile l'intera chat dopo una
  // deprecazione, senza sostituire la preferenza esplicita al primo tentativo.
  return [...new Set([configuredModel, DEFAULT_GEMINI_MODEL])];
}

function dataUrlPart(url) {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/s);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : { text: String(url || '') };
}

function messageParts(content) {
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (part?.type === 'text') return [{ text: String(part.text || '') }];
      if (part?.type === 'image_url') return [dataUrlPart(part.image_url?.url)];
      return [];
    });
  }
  return [{ text: String(content || '') }];
}

export function toGeminiMessages(messages = []) {
  const system = messages.find((entry) => entry.role === 'system');
  const contents = messages.filter((entry) => entry.role !== 'system').map((entry) => {
    if (entry.role === 'assistant') {
      const parts = [];
      if (entry.content) parts.push(...messageParts(entry.content));
      for (const call of entry.tool_calls || []) {
        try {
          const functionCall = {
            name: call.function.name, args: JSON.parse(call.function.arguments || '{}'), id: call.id,
          };
          // Gemini 3 richiede di ripassare la thought signature esattamente
          // sulla stessa functionCall quando si usa REST senza SDK.
          const thoughtSignature = call.thoughtSignature || call.thought_signature;
          parts.push({ functionCall, ...(thoughtSignature ? { thoughtSignature } : {}) });
        } catch { /* malformed tool arguments are ignored by the adapter */ }
      }
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    }
    if (entry.role === 'tool') {
      let response = entry.content;
      try { response = JSON.parse(entry.content); } catch { /* plain text is valid */ }
      return { role: 'user', parts: [{ functionResponse: {
        name: entry.name || 'update_requirements', response: { result: response }, id: entry.tool_call_id,
      } }] };
    }
    return { role: 'user', parts: messageParts(entry.content) };
  });
  // generateContent non accetta una cronologia che termini con un turno model.
  // Può accadere nel follow-up quando il provider restituisce un tool call senza
  // testo: aggiungiamo un prompt neutro, senza alterare i messaggi persistiti.
  if (contents.at(-1)?.role === 'model') contents.push({ role: 'user', parts: [{ text: 'Continua esclusivamente in italiano. Non usare inglese nel testo destinato all’utente.' }] });
  return { systemInstruction: system ? { parts: messageParts(system.content) } : undefined, contents };
}

export function toGeminiTools(tools = []) {
  const declarations = tools.map((tool) => tool?.function).filter(Boolean).map((fn) => ({
    name: fn.name,
    description: fn.description,
    // Groq ammette union type con null per i campi opzionali; il formato
    // function declaration di Gemini richiede invece il tipo concreto.
    parameters: fn.parameters?.properties ? {
      ...fn.parameters,
      properties: Object.fromEntries(Object.entries(fn.parameters.properties).map(([name, property]) => [name, {
        ...property,
        ...(Array.isArray(property.type) ? { type: property.type.find((type) => type !== 'null') } : {}),
      }])),
    } : fn.parameters,
  }));
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

export function fromGeminiResponse(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text).join('');
  const toolCalls = parts.filter((part) => part.functionCall?.name).map((part, index) => ({
    id: part.functionCall.id || `gemini-call-${index}`,
    type: 'function',
    function: {
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args || {}),
    },
    ...((part.thoughtSignature || part.thought_signature)
      ? { thoughtSignature: part.thoughtSignature || part.thought_signature } : {}),
  }));
  return { choices: [{ message: { role: 'assistant', content: text, tool_calls: toolCalls } }] };
}

export function createGeminiCompletion(fetchImpl = fetch, run = createLlmResilience({ maxRetries })) {
  return async (payload) => {
    if (!enabled) throw new Error('GEMINI_API_KEY non configurata o fallback non abilitato');
    const { systemInstruction, contents } = toGeminiMessages(payload.messages);
    const tools = toGeminiTools(payload.tools);
    const requestBody = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      ...(payload.temperature == null ? {} : { generationConfig: { temperature: payload.temperature } }),
    };
    try {
      let lastError;
      for (const candidateModel of getGeminiModelCandidates()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await run(() => fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            },
          ).then(async (result) => {
            const body = await result.json().catch(() => ({}));
            if (!result.ok) {
              const error = new Error(body?.error?.message || `Gemini HTTP ${result.status}`);
              error.status = result.status;
              throw error;
            }
            return fromGeminiResponse(body);
          }).catch((error) => {
            if (error?.name === 'AbortError') {
              const timeoutError = new Error('Gemini request timeout');
              timeoutError.code = 'ETIMEDOUT';
              throw timeoutError;
            }
            throw error;
          }));
        } catch (error) {
          lastError = error;
          if (error?.status !== 404 || candidateModel === DEFAULT_GEMINI_MODEL) throw error;
          logLlmEvent('llm_gemini_model_fallback', {
            provider: 'gemini', from: candidateModel, to: DEFAULT_GEMINI_MODEL, ...llmErrorFields(error),
          });
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError;
    } catch (error) {
      logLlmEvent('llm_gemini_error', { ...llmErrorFields(error) });
      throw error;
    }
  };
}

export const createDefaultGeminiCompletion = createGeminiCompletion();
