import Groq from 'groq-sdk';
import { z } from 'zod';
import { createLlmResilience, llmErrorFields, logLlmEvent } from './llmResilience.js';
import { metrics } from './metrics.js';
import { GEMINI_ENABLED, GEMINI_VISION_ENABLED, createDefaultGeminiCompletion } from './geminiService.js';

function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function envNonNegativeInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
export const VISION_TIMEOUT_MS = envPositiveInteger('GROQ_VISION_TIMEOUT_MS', 15000);
export const VISION_MAX_RETRIES = envNonNegativeInteger('GROQ_VISION_MAX_RETRIES', 0);
const VISION_ENABLED = process.env.GROQ_VISION_ENABLED === 'true';
const FREE_TIER_CONFIRMED = process.env.GROQ_VISION_FREE_TIER_CONFIRMED === 'true';
const hasApiKey = Boolean(process.env.GROQ_API_KEY)
  && !['your-groq-api-key', 'dummy_test_key'].includes(process.env.GROQ_API_KEY);
const visionGroq = hasApiKey ? new Groq({
  apiKey: process.env.GROQ_API_KEY,
  timeout: VISION_TIMEOUT_MS,
  maxRetries: 0,
}) : null;
const runVision = createLlmResilience({
  // L'upload è sincrono: Groq ha già una policy di retry per la chat, ma due
  // retry vision possono trattenere il primo upload per ~30s prima del fallback.
  maxRetries: VISION_MAX_RETRIES,
  baseDelayMs: envPositiveInteger('LLM_RETRY_BASE_DELAY_MS', 250),
  maxDelayMs: envPositiveInteger('LLM_RETRY_MAX_DELAY_MS', 2000),
  failureThreshold: envPositiveInteger('LLM_CIRCUIT_FAILURE_THRESHOLD', 3),
  cooldownMs: envPositiveInteger('LLM_CIRCUIT_COOLDOWN_MS', 30000),
});
const geminiVisionAvailable = GEMINI_ENABLED && GEMINI_VISION_ENABLED;
const groqVisionAvailable = VISION_ENABLED && FREE_TIER_CONFIRMED && hasApiKey && Boolean(visionGroq);

function canFallbackToGemini(error) {
  return error?.code === 'GROQ_CIRCUIT_OPEN' || error?.status === 408 || error?.status === 429
    || (error?.status >= 500 && error?.status <= 599)
    || ['APIConnectionError', 'APIConnectionTimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']
      .includes(error?.name || error?.code);
}

const ALLOWED_TAGS = new Set([
  'cultura', 'sport', 'relax', 'nightlife', 'natura', 'famiglia', 'lusso',
  'gastronomia', 'mare', 'montagna', 'architettura', 'arte',
]);

const visionResultSchema = z.object({
  description: z.string().trim().min(1).max(500),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
}).strict();

function fallback(reason) {
  metrics.increment('vision_analysis_total', { outcome: 'metadata_only', reason });
  return { status: 'metadata_only', description: null, tags: [], reason };
}

function providerReason(error) {
  const message = error?.error?.message || error?.message || '';
  if (/invalid image data|image.*(invalid|malformed|unsupported)/i.test(message)) return 'vision_invalid_image';
  return /model.*(does not exist|not found|not available|decommissioned)|model.*access/i.test(message)
    ? 'vision_model_unavailable'
    : 'vision_provider_error';
}

function parseVisionJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(text);
  } catch {
    const object = text.match(/\{[\s\S]*\}/)?.[0];
    return object ? JSON.parse(object) : null;
  }
}

/**
 * Analizza un'immagine già validata. Il risultato è volutamente limitato a
 * descrizione e tag controllati; un errore non rende fallito l'upload.
 */
export async function analyzePreferenceImage({ buffer, mimeType }) {
  if (!VISION_ENABLED && !geminiVisionAvailable) return fallback('vision_disabled');
  if (!FREE_TIER_CONFIRMED && !geminiVisionAvailable) return fallback('free_tier_not_confirmed');
  if (!groqVisionAvailable && !geminiVisionAvailable) return fallback('provider_unconfigured');
  if (!Buffer.isBuffer(buffer) || !/^image\/(?:jpeg|png|webp)$/.test(mimeType || '')) {
    return fallback('unsupported_image');
  }

  try {
    const payload = {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Descrivi questa immagine come riferimento per preferenze di viaggio.',
              'Rispondi esclusivamente con JSON valido: {"description":"...","tags":["..."]}.',
              'Descrivi solo elementi chiaramente visibili, senza inventare persone, luoghi o attività.',
              'Se non riconosci segnali utili, usa una descrizione breve e tags vuoto.',
              `Usa solo questi tag in italiano: ${[...ALLOWED_TAGS].join(', ')}. Massimo 8 tag.`,
            ].join(' '),
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
        ],
      }],
      temperature: 0,
      max_tokens: 350,
    };
    let completion;
    try {
      if (!groqVisionAvailable) throw new Error('Groq vision non configurato');
      completion = await runVision(() => visionGroq.chat.completions.create(payload));
    } catch (error) {
      if (!geminiVisionAvailable || !canFallbackToGemini(error)) throw error;
      logLlmEvent('vision_provider_fallback', { from: 'groq', to: 'gemini', ...llmErrorFields(error) });
      completion = await createDefaultGeminiCompletion({ messages: payload.messages });
    }
    const raw = completion.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = visionResultSchema.parse(parseVisionJson(raw) || {});
    } catch {
      return fallback('invalid_model_output');
    }
    const tags = [...new Set(parsed.tags
      .map((tag) => tag.toLocaleLowerCase('it-IT'))
      .filter((tag) => ALLOWED_TAGS.has(tag)))];
    metrics.increment('vision_analysis_total', { outcome: 'completed', reason: 'success' });
    return { status: 'completed', description: parsed.description, tags, reason: null };
  } catch (error) {
    const reason = providerReason(error);
    logLlmEvent('vision_analysis_fallback', { reason, ...llmErrorFields(error) });
    return fallback(reason);
  }
}

export const visionConfig = Object.freeze({
  enabled: VISION_ENABLED || geminiVisionAvailable,
  freeTierConfirmed: FREE_TIER_CONFIRMED || geminiVisionAvailable,
  model: VISION_MODEL,
  timeoutMs: VISION_TIMEOUT_MS,
  maxRetries: VISION_MAX_RETRIES,
});
