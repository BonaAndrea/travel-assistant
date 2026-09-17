/**
 * Wrapper attorno a Groq (API compatibile OpenAI, gratuita) per:
 * 1) estrarre/aggiornare i requisiti di viaggio dalla conversazione (via tool-calling)
 * 2) generare la risposta testuale per l'utente
 *
 * Scelta: un'unica chiamata con tool-calling invece di due chiamate separate (extract + reply),
 * per ridurre latenza/costo. Il modello può chiamare `update_requirements` quando l'utente
 * fornisce/modifica dati, e risponde comunque in linguaggio naturale nello stesso turno.
 */
import Groq from 'groq-sdk';
import { createLlmResilience, llmErrorFields, logLlmEvent } from './llmResilience.js';
import { metrics, metricErrorCategory } from './metrics.js';
import {
  GEMINI_ENABLED, GEMINI_VISION_ENABLED, createDefaultGeminiCompletion,
} from './geminiService.js';

function envNonNegativeInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const LLM_TIMEOUT_MS = envPositiveInteger('GROQ_TIMEOUT_MS', 10000);
export const LLM_RESILIENCE_CONFIG = Object.freeze({
  maxRetries: envNonNegativeInteger('LLM_MAX_RETRIES', 2),
  baseDelayMs: envPositiveInteger('LLM_RETRY_BASE_DELAY_MS', 250),
  maxDelayMs: envPositiveInteger('LLM_RETRY_MAX_DELAY_MS', 2000),
  failureThreshold: envPositiveInteger('LLM_CIRCUIT_FAILURE_THRESHOLD', 3),
  cooldownMs: envPositiveInteger('LLM_CIRCUIT_COOLDOWN_MS', 30000),
});

// Disable SDK retries: the shared resilience policy owns retry counts and backoff.
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: 0 })
  : null;
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
export const FALLBACK_MODELS = [
  DEFAULT_MODEL,
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'meta-llama/llama-4-scout-17b-16e-instruct',
];

export function getCandidateModels(configuredModel) {
  const models = [];
  if (configuredModel) models.push(configuredModel);
  for (const model of FALLBACK_MODELS) {
    if (!models.includes(model)) models.push(model);
  }
  return models;
}

const MODEL_CANDIDATES = getCandidateModels(process.env.GROQ_MODEL);
const CHAT_VISION_ENABLED = process.env.GROQ_VISION_ENABLED === 'true'
  && process.env.GROQ_VISION_FREE_TIER_CONFIRMED === 'true';
const CHAT_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
export const CHAT_VISION_MAX_RETRIES = envNonNegativeInteger('GROQ_CHAT_VISION_MAX_RETRIES', 0);

export const LLM_FALLBACK_ENABLED = GEMINI_ENABLED;

export function sanitizeLlmOutput(value) {
  let text = String(value || '');
  text = text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  text = text.replace(/<(think|analysis|reasoning)\b[^>]*>[\s\S]*$/gi, '');
  text = text.replace(/<\/?(?:think|analysis|reasoning)\b[^>]*>/gi, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const ENGLISH_ASSISTANT_MARKERS = [
  /\bI've got\b/i, /\bI have all\b/i, /\bI've collected\b/i, /\ball the details\b/i,
  /\bnext requirement\b/i, /\bnext step\b/i, /\blet's proceed\b/i, /\bprepare the itinerary\b/i,
  /\bconfirm the itinerary\b/i, /\bdeparture airport\b/i, /\breturn date\b/i,
];

function likelyEnglishAssistantCopy(text) {
  return ENGLISH_ASSISTANT_MARKERS.some((marker) => marker.test(text));
}

export function enforceItalianAssistantMessage(value, { phase, hasUpdates = false } = {}) {
  const text = sanitizeLlmOutput(value);
  if (!text || !likelyEnglishAssistantCopy(text)) return text;
  if (phase === 'confirming') return 'Ho raccolto tutti i dati del viaggio. Confermi che vada bene così?';
  if (hasUpdates) return 'Ho aggiornato la richiesta con i nuovi dati. Continuiamo con il prossimo requisito.';
  return 'Continuiamo in italiano: indicami il prossimo dato del viaggio.';
}

function normalizedText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it-IT');
}

function explicitlyMentioned(value, userText) {
  if (typeof value === 'number') return new RegExp(`\\b${value}\\b`).test(userText);
  if (Array.isArray(value)) return value.length > 0 && value.every((entry) => explicitlyMentioned(entry, userText));
  return normalizedText(userText).includes(normalizedText(value));
}

function confirmedTextUpdates(fields, history, imageAttachments) {
  if (!imageAttachments.length) return fields;
  const userText = normalizedText([...history].reverse().find((entry) => entry.role === 'user')?.content);
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => explicitlyMentioned(value, userText)));
}

function isModelAccessError(error) {
  const message = error?.error?.message || error?.message || '';
  return /model.*(does not exist|not found|not available|decommissioned)|you do not have access/i.test(message);
}

export function createCompletionClient(create, models = MODEL_CANDIDATES, run = createLlmResilience()) {
  return async (payload) => {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await run(async () => {
        let lastError;
        for (const model of models) {
          try {
            return await create({ ...payload, model });
          } catch (error) {
            lastError = error;
            if (!isModelAccessError(error)) throw error;
            logLlmEvent('llm_model_fallback', {
              model,
              ...llmErrorFields(error),
            });
          }
        }
        throw lastError;
      });
      metrics.increment('llm_requests_total', { outcome: 'success' });
      metrics.observe('llm_request_duration_ms', Number(process.hrtime.bigint() - startedAt) / 1e6, { outcome: 'success' });
      return result;
    } catch (error) {
      metrics.increment('llm_requests_total', { outcome: 'failed', error: metricErrorCategory(error) });
      metrics.observe('llm_request_duration_ms', Number(process.hrtime.bigint() - startedAt) / 1e6, { outcome: 'failed' });
      throw error;
    }
  };
}

const createGroqCompletion = (payload) => {
  if (!groq) throw new Error('GROQ_API_KEY non configurata');
  return groq.chat.completions.create(payload);
};
const createChatCompletion = createCompletionClient(
  createGroqCompletion, MODEL_CANDIDATES, createLlmResilience(LLM_RESILIENCE_CONFIG),
);
const createVisualChatCompletion = createCompletionClient(
  // I modelli testuali Groq non sono fallback validi per un turno con immagini:
  // dopo il modello vision configurato deve intervenire il provider Gemini.
  createGroqCompletion, [CHAT_VISION_MODEL],
  createLlmResilience({ ...LLM_RESILIENCE_CONFIG, maxRetries: CHAT_VISION_MAX_RETRIES }),
);

function canFallbackToGemini(error) {
  return !error || isModelAccessError(error) || error.code === 'GROQ_CIRCUIT_OPEN' || error.code === 'GROQ_API_KEY_MISSING'
    || error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599)
    || ['APIConnectionError', 'APIConnectionTimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']
      .includes(error?.name || error?.code);
}

function createProviderFallback(primary, { vision = false } = {}) {
  return async (payload) => {
    try {
      return await primary(payload);
    } catch (error) {
      if (!GEMINI_ENABLED || (vision && !GEMINI_VISION_ENABLED) || !canFallbackToGemini(error)) throw error;
      logLlmEvent('llm_provider_fallback', { from: 'groq', to: 'gemini', ...llmErrorFields(error) });
      return createDefaultGeminiCompletion(payload);
    }
  };
}

const createChatProviderCompletion = createProviderFallback(createChatCompletion);
const createVisualProviderCompletion = createProviderFallback(createVisualChatCompletion, { vision: true });

const REQUIREMENT_TOOL = {
  type: 'function',
  function: {
    name: 'update_requirements',
    description:
      "Aggiorna i requisiti di viaggio raccolti finora con i nuovi dati forniti dall'utente in questo messaggio. Chiamala SOLO se l'utente ha fornito almeno un dato nuovo o una modifica.",
    parameters: {
      type: 'object',
      properties: {
        budget: { type: ['number', 'null'], description: 'Budget totale in EUR; ometti il campo se non fornito' },
        country: { type: ['string', 'null'], description: 'Nazione di destinazione; ometti il campo se non fornito' },
        destinationCity: { type: ['string', 'null'], description: 'Città di destinazione, se indicata o confermata dallutente' },
        departureAirport: { type: ['string', 'null'], description: 'Aeroporto/città di partenza; ometti il campo se non fornito' },
        activityPreferences: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'es. cultura, sport, relax, nightlife; ometti il campo se non fornito',
        },
        travelMonth: { type: ['string', 'null'], description: 'Mese di viaggio, es. "luglio"; ometti il campo se non fornito' },
        durationDays: { type: ['number', 'null'], description: 'Durata del viaggio in giorni; ometti il campo se non fornito' },
        participants: { type: ['number', 'null'], description: 'Numero di partecipanti; ometti il campo se non fornito' },
        outboundDate: { type: ['string', 'null'], description: 'Data di partenza esplicita in formato ISO, se fornita' },
        returnDate: { type: ['string', 'null'], description: 'Data di ritorno esplicita in formato ISO, se fornita' },
      },
    },
  },
};

export function buildSystemPrompt(requirements, phase, preferenceImages = [], generationIssue = null) {
  const analyzedImages = preferenceImages.filter((image) => image.analysisStatus === 'completed');
  const imageContext = preferenceImages.length > 0
    ? `\nL'utente ha caricato ${preferenceImages.length} immagine/i come riferimento di preferenza. `
      + `Le analisi disponibili sono segnali non confermati: ${JSON.stringify(analyzedImages.map((image) => ({
        description: image.description, tags: Array.isArray(image.tags) ? image.tags : [],
      })))}\n`
      + 'Usa descrizione e tag solo per chiedere conferma o suggerire preferenze; non trattarli come requisiti dichiarati dall’utente.'
    : '';
  const generationContext = generationIssue && typeof generationIssue === 'object'
    ? `\nL'ultimo tentativo di generazione è fallito per un vincolo del catalogo. Contesto non autorevole: ${JSON.stringify({
      errorCode: generationIssue.errorCode,
      message: generationIssue.message,
      alternatives: Array.isArray(generationIssue.alternatives) ? generationIssue.alternatives.slice(0, 12) : [],
      requested: generationIssue.requested || null,
      availableReturns: Array.isArray(generationIssue.availableReturns) ? generationIssue.availableReturns.slice(0, 12) : [],
    })}\nSpiega il vincolo, chiedi quale requisito desidera modificare (date, durata, aeroporto, budget o preferenze) e proponi esclusivamente le alternative presenti nel contesto. Non avviare una nuova generazione e non considerare il contesto un requisito dell'utente.`
    : '';
  return `Sei un assistente di viaggio. Raccogli questi dati dall'utente, anche in più messaggi:
budget, nazione, aeroporto di partenza, preferenze attività, mese di viaggio, durata (giorni), numero partecipanti.

Stato attuale raccolto: ${JSON.stringify(requirements)}
Fase corrente: ${phase}
${imageContext}
${generationContext}

Regole:
- VINCOLO DI LINGUA: ogni testo destinato all'utente deve essere esclusivamente in italiano, anche dopo errori, timeout, fallback di provider, tool call e richieste di conferma. Non usare frasi inglesi.
- Se manca un dato o è ambiguo/incoerente (es. durata 10 giorni ma budget palesemente insufficiente per un volo+hotel), chiedi UN chiarimento alla volta, in modo naturale.
- Se l'utente fornisce o modifica un dato, chiama SEMPRE il tool update_requirements con solo i campi nuovi/cambiati. Non inviare mai null: ometti i campi che non aggiorni.
- Se l'utente indica o conferma una città specifica, salva anche destinationCity oltre alla nazione. Non sostituire una città confermata con un'altra città della stessa nazione.
- Quando tutti i dati sono presenti e coerenti, riepiloga i requisiti usando SEMPRE un elenco puntato chiaro e leggibile con trattini (es. "- Destinazione: Spagna", "- Budget: 1000€"), MAI tabelle Markdown (|), e chiedi conferma esplicita prima di generare l'itinerario.
- Non inventare voli/hotel/attività: quello lo fa un altro componente del sistema, tu gestisci solo la raccolta dati e la conversazione.
- Rispondi sempre in italiano, in modo colloquiale e conciso.`;
}

/**
 * @param {Array<{role:string, content:string}>} history
 * @param {object} requirements stato corrente dei requisiti
 * @param {string} phase fase corrente della conversazione
 * @param {Array<{id:string,mimeType:string,sizeBytes:number}>} preferenceImages immagini caricate come segnali non interpretati
 */
export async function chatTurn(history, requirements, phase, preferenceImages = [], imageAttachments = [], generationIssue = null) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(requirements, phase, preferenceImages, generationIssue) },
    ...history,
  ];

  const visionAvailable = imageAttachments.length > 0 && (CHAT_VISION_ENABLED || GEMINI_VISION_ENABLED);
  const visualMessages = visionAvailable
    ? messages.map((entry, index) => {
      if (index !== messages.length - 1 || entry.role !== 'user') return entry;
      return {
        ...entry,
        content: [
          { type: 'text', text: entry.content },
          ...imageAttachments.map((image) => ({
            type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}` },
          })),
        ],
      };
    })
    : messages;
  const completionClient = visionAvailable ? createVisualProviderCompletion : createChatProviderCompletion;

  const completion = await completionClient({
    messages: visualMessages,
    tools: [REQUIREMENT_TOOL],
    tool_choice: 'auto',
    temperature: 0.4,
  });

  const choice = completion.choices[0];
  let updatedFields = {};

  const toolCalls = choice.message.tool_calls || [];
  for (const call of toolCalls) {
    if (call.function.name === 'update_requirements') {
      try {
        const parsed = JSON.parse(call.function.arguments);
        const nonNullFields = Object.fromEntries(Object.entries(parsed || {})
          .filter(([, value]) => value !== null && value !== undefined));
        updatedFields = { ...updatedFields, ...nonNullFields };
      } catch {
        // argomenti malformati: ignoriamo l'update, la conversazione prosegue comunque
      }
    }
  }
  updatedFields = confirmedTextUpdates(updatedFields, history, imageAttachments);

  let assistantMessage = enforceItalianAssistantMessage(choice.message.content, {
    phase, hasUpdates: Object.keys(updatedFields).length > 0,
  });

  // Se il modello ha SOLO chiamato il tool senza testo, facciamo un secondo giro
  // per ottenere una risposta naturale coerente con i dati aggiornati.
  if (!assistantMessage) {
    try {
      const followUp = await completionClient({
        messages: [
          ...visualMessages,
          { role: 'assistant', content: '', tool_calls: toolCalls },
          ...toolCalls.map((c) => ({
            role: 'tool',
            tool_call_id: c.id,
            content: 'ok',
          })),
        ],
        temperature: 0.4,
      });
      assistantMessage = enforceItalianAssistantMessage(followUp.choices[0].message.content, {
        phase, hasUpdates: Object.keys(updatedFields).length > 0,
      });
    } catch (error) {
      // Il tool-call ha già prodotto un aggiornamento valido: un timeout della
      // sola risposta testuale non deve annullare il turno o bloccare la chat.
      logLlmEvent('llm_followup_fallback', { ...llmErrorFields(error) });
      assistantMessage = 'Ho aggiornato la richiesta con i nuovi dati. Continuiamo con il prossimo requisito.';
    }
  }

  return { assistantMessage: assistantMessage || 'Posso usare l’immagine come ispirazione, ma dimmi quali preferenze vuoi confermare.', updatedFields };
}

/**
 * Genera una motivazione testuale sintetica del perché un'attività è stata proposta,
 * a partire dai risultati del retrieval semantico (RAG).
 */
export async function explainActivityChoice(activityText, userPreferences) {
  const completion = await createChatCompletion({
    messages: [
      {
        role: 'user',
        content: `In una frase, spiega perché questa attività è adatta alle preferenze "${userPreferences}": ${activityText}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 60,
  });
  return sanitizeLlmOutput(completion.choices[0].message.content);
}
