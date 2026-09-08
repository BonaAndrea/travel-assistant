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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'dummy_test_key' });
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

function isModelAccessError(error) {
  const message = error?.error?.message || error?.message || '';
  return /model.*(does not exist|not found|not available|decommissioned)|you do not have access/i.test(message);
}

async function createChatCompletion(payload) {
  let lastError;

  for (const model of MODEL_CANDIDATES) {
    try {
      return await groq.chat.completions.create({ ...payload, model });
    } catch (error) {
      lastError = error;
      if (!isModelAccessError(error)) throw error;
      console.warn(`Groq model ${model} unavailable; retrying with the next supported model.`);
    }
  }

  throw lastError;
}

const REQUIREMENT_TOOL = {
  type: 'function',
  function: {
    name: 'update_requirements',
    description:
      "Aggiorna i requisiti di viaggio raccolti finora con i nuovi dati forniti dall'utente in questo messaggio. Chiamala SOLO se l'utente ha fornito almeno un dato nuovo o una modifica.",
    parameters: {
      type: 'object',
      properties: {
        budget: { type: 'number', description: 'Budget totale in EUR' },
        country: { type: 'string', description: 'Nazione di destinazione' },
        departureAirport: { type: 'string', description: 'Aeroporto/città di partenza' },
        activityPreferences: {
          type: 'array',
          items: { type: 'string' },
          description: 'es. cultura, sport, relax, nightlife',
        },
        travelMonth: { type: 'string', description: 'Mese di viaggio, es. "luglio"' },
        durationDays: { type: 'number', description: 'Durata del viaggio in giorni' },
        participants: { type: 'number', description: 'Numero di partecipanti' },
      },
    },
  },
};

function systemPrompt(requirements, phase) {
  return `Sei un assistente di viaggio. Raccogli questi dati dall'utente, anche in più messaggi:
budget, nazione, aeroporto di partenza, preferenze attività, mese di viaggio, durata (giorni), numero partecipanti.

Stato attuale raccolto: ${JSON.stringify(requirements)}
Fase corrente: ${phase}

Regole:
- Se manca un dato o è ambiguo/incoerente (es. durata 10 giorni ma budget palesemente insufficiente per un volo+hotel), chiedi UN chiarimento alla volta, in modo naturale.
- Se l'utente fornisce o modifica un dato, chiama SEMPRE il tool update_requirements con solo i campi nuovi/cambiati.
- Quando tutti i dati sono presenti e coerenti, riepiloga i requisiti usando SEMPRE un elenco puntato chiaro e leggibile con trattini (es. "- Destinazione: Spagna", "- Budget: 1000€"), MAI tabelle Markdown (|), e chiedi conferma esplicita prima di generare l'itinerario.
- Non inventare voli/hotel/attività: quello lo fa un altro componente del sistema, tu gestisci solo la raccolta dati e la conversazione.
- Rispondi sempre in italiano, in modo colloquiale e conciso.`;
}

/**
 * @param {Array<{role:string, content:string}>} history
 * @param {object} requirements stato corrente dei requisiti
 * @param {string} phase fase corrente della conversazione
 */
export async function chatTurn(history, requirements, phase) {
  const messages = [
    { role: 'system', content: systemPrompt(requirements, phase) },
    ...history,
  ];

  const completion = await createChatCompletion({
    messages,
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
        updatedFields = { ...updatedFields, ...JSON.parse(call.function.arguments) };
      } catch {
        // argomenti malformati: ignoriamo l'update, la conversazione prosegue comunque
      }
    }
  }

  let assistantMessage = choice.message.content;

  // Se il modello ha SOLO chiamato il tool senza testo, facciamo un secondo giro
  // per ottenere una risposta naturale coerente con i dati aggiornati.
  if (!assistantMessage) {
    const followUp = await createChatCompletion({
      messages: [
        ...messages,
        { role: 'assistant', content: '', tool_calls: toolCalls },
        ...toolCalls.map((c) => ({
          role: 'tool',
          tool_call_id: c.id,
          content: 'ok',
        })),
      ],
      temperature: 0.4,
    });
    assistantMessage = followUp.choices[0].message.content;
  }

  return { assistantMessage, updatedFields };
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
  return completion.choices[0].message.content;
}
