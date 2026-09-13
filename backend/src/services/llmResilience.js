import { APIConnectionError } from 'groq-sdk';

export function logLlmEvent(event, fields = {}, logger = console.warn) {
  try {
    logger(JSON.stringify({ event, provider: 'groq', ...fields }));
  } catch {
    // Logging must never change the provider error or break the fallback path.
  }
}

function sanitizeErrorMessage(error) {
  const raw = error?.error?.message || error?.message || error?.cause?.message || '';
  return String(raw)
    // Gli errori di tool-calling possono contenere il prompt completo nel
    // campo failed_generation: non è diagnostica sicura e va eliminato.
    .replace(/(failed_generation["']?\s*:\s*["'])(?:\\.|[^"'\\])*/gi, '$1[redacted]')
    .replace(/Bearer\s+[^\s,]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gsk|sk)_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 300);
}

/**
 * Campi diagnostici sicuri per distinguere rete, timeout, HTTP e rifiuti del provider.
 * Non include payload, chiavi o header: il messaggio viene troncato e ripulito.
 */
export function llmErrorFields(error) {
  const constructorName = error?.constructor?.name;
  const fields = {
    error: error?.code || error?.name
      || (constructorName && constructorName !== 'Object' ? constructorName : 'unknown'),
  };
  if (Number.isInteger(error?.status)) fields.errorStatus = error.status;
  if (error?.type) fields.errorType = String(error.type).slice(0, 80);
  const message = sanitizeErrorMessage(error);
  if (message && message !== fields.error) fields.errorMessage = message;
  return fields;
}

export class CircuitOpenError extends Error {
  constructor(retryAfterMs) {
    super('Groq temporaneamente non disponibile. Riprova tra poco.');
    this.name = 'CircuitOpenError';
    this.code = 'GROQ_CIRCUIT_OPEN';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTransientGroqError(error) {
  const status = error?.status;
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
    || error instanceof APIConnectionError
    || ['APIConnectionError', 'APIConnectionTimeoutError'].includes(error?.name)
    || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error?.code);
}

export function retryAfterMsFromError(error) {
  const header = error?.headers?.['retry-after'] || error?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const message = String(error?.error?.message || error?.message || '');
  const match = message.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (!match) return null;
  const milliseconds = ((Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60
    + Number(match[3] || 0)) * 1000;
  return milliseconds > 0 ? Math.ceil(milliseconds) : null;
}

// Dependencies are injectable so retry and recovery tests never wait on wall time.
export function createLlmResilience({
  maxRetries = 2,
  baseDelayMs = 250,
  maxDelayMs = 2000,
  failureThreshold = 3,
  cooldownMs = 30000,
  now = Date.now,
  random = Math.random,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console.warn,
} = {}) {
  let failures = 0;
  let openUntil = 0;
  let providerOpenUntil = 0;
  let probeInFlight = false;
  let generation = 0;

  return async function run(operation) {
    if (openUntil > now() || providerOpenUntil > now() || probeInFlight) {
      logLlmEvent('llm_circuit_blocked', {
        retryAfterMs: Math.max(0, Math.max(openUntil, providerOpenUntil) - now()),
      }, logger);
      throw new CircuitOpenError(Math.max(0, Math.max(openUntil, providerOpenUntil) - now()));
    }
    const probing = openUntil !== 0;
    if (probing) probeInFlight = true;
    const startedGeneration = generation;

    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await operation();
          if (generation === startedGeneration) {
            failures = 0;
            openUntil = 0;
            providerOpenUntil = 0;
          }
          return result;
        } catch (error) {
          if (!isTransientGroqError(error)) {
            // An HTTP client error still proves that the provider is reachable.
            if (generation === startedGeneration) {
              failures = 0;
              openUntil = 0;
            }
            throw error;
          }
          if (attempt >= maxRetries || probing) throw error;
          const ceiling = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
          const delayMs = Math.floor(ceiling * (0.5 + random() * 0.5));
          logLlmEvent('llm_retry', {
            attempt: attempt + 1,
            delayMs,
            ...llmErrorFields(error),
          }, logger);
          await sleep(delayMs);
        }
      }
    } catch (error) {
      if (isTransientGroqError(error) && generation === startedGeneration) {
        failures += 1;
        if (probing || failures >= failureThreshold) {
          const providerRetryAfterMs = retryAfterMsFromError(error) || 0;
          openUntil = now() + cooldownMs;
          providerOpenUntil = now() + providerRetryAfterMs;
          generation += 1;
          logLlmEvent('llm_circuit_open', {
            failures,
            cooldownMs,
            ...llmErrorFields(error),
          }, logger);
        }
      }
      throw error;
    } finally {
      if (probing) probeInFlight = false;
    }
  };
}
