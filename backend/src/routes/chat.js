import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { chatTurn } from '../services/llmService.js';
import { getMissingFields, validateConsistency, isComplete } from '../services/requirementsService.js';
import { generateItinerary } from '../services/itineraryService.js';

const router = Router();
router.use(requireAuth);

const FIELD_LABELS = {
  budget: 'budget totale',
  country: 'nazione di destinazione',
  departureAirport: 'aeroporto/città di partenza',
  activityPreferences: 'preferenze sulle attività',
  travelMonth: 'mese di viaggio',
  durationDays: 'durata del viaggio (giorni)',
  participants: 'numero di partecipanti',
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeConversationState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { phase: 'unknown', requirements: {} };
  }
  return {
    ...state,
    phase: typeof state.phase === 'string' && state.phase ? state.phase : 'unknown',
    requirements: state.requirements && typeof state.requirements === 'object' && !Array.isArray(state.requirements)
      ? state.requirements
      : {},
  };
}

export function isConfirmationMessage(message) {
  const normalized = String(message || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  return /(?:^|\s)(?:si|conferma|confermo|ok|vai)(?:\s|$)/.test(normalized);
}

// Crea una nuova conversazione
router.post('/conversations', asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.create({
    data: { userId: req.userId, state: { phase: 'collecting', requirements: {} } },
  });
  res.status(201).json({ conversationId: conversation.id });
}));

// Elenco cronologico, paginato e sempre filtrato sull'utente autenticato.
router.get('/conversations', asyncHandler(async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const requestedPageSize = parsePositiveInteger(req.query.pageSize, DEFAULT_PAGE_SIZE);
  if (!page || !requestedPageSize) {
    return res.status(400).json({ error: 'page e pageSize devono essere interi positivi' });
  }
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  const where = { userId: req.userId };
  const [totalItems, conversations] = await prisma.$transaction([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true, itineraries: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { role: true, content: true, createdAt: true } },
        itineraries: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, totalCost: true } },
      },
    }),
  ]);

  const totalPages = Math.ceil(totalItems / pageSize);
  res.json({
    items: conversations.map((conversation) => {
      const state = normalizeConversationState(conversation.state);
      return {
        id: conversation.id,
        status: state.phase,
        requirements: state.requirements,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation._count.messages,
        itineraryCount: conversation._count.itineraries,
        lastMessage: conversation.messages[0] || null,
        latestItinerary: conversation.itineraries[0] || null,
      };
    }),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasPreviousPage: page > 1,
      hasNextPage: page < totalPages,
    },
  });
}));

// Invia un messaggio in una conversazione esistente
router.post('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Campo "message" mancante' });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation || conversation.userId !== req.userId) {
    return res.status(404).json({ error: 'Conversazione non trovata' });
  }

  await prisma.message.create({ data: { conversationId: id, role: 'user', content: message } });

  const state = conversation.state;
  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: 'user', content: message });

  console.log('DEBUG confirm check', { phase: state.phase, message, normalized: isConfirmationMessage(message) });

  // Fase speciale: l'utente sta confermando la generazione dell'itinerario
  if (state.phase === 'confirming' && isConfirmationMessage(message)) {
    const result = await generateItinerary(state.requirements);
    state.phase = result.error ? 'confirming' : 'itinerary_proposed'; // errore -> resta in fase di modifica requisiti
    state.lastResult = result;
    await prisma.conversation.update({ where: { id }, data: { state } });

    const reply = result.error
      ? `Non sono riuscito a comporre un itinerario: ${result.error} Vuoi modificare qualche requisito?`
      : result.primary?.withinBudget
        ? 'Ecco l\'itinerario proposto, entro il tuo budget. Vuoi procedere con la prenotazione?'
        : result.alternative
          ? 'Non è stato possibile rispettare tutti i vincoli col budget indicato: ti propongo un\'alternativa con alcuni compromessi (vedi dettagli). Vuoi procedere con quella?'
          : 'Non sono riuscito a comporre un itinerario compatibile con i criteri indicati. Vuoi modificare budget, mese o destinazione?';

    await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
    return res.json({ reply, phase: state.phase, itinerary: result });
  }

  // Fase normale: raccolta/aggiornamento requisiti via LLM
  const { assistantMessage, updatedFields } = await chatTurn(history, state.requirements, state.phase);
  state.requirements = { ...state.requirements, ...updatedFields };

  const missing = getMissingFields(state.requirements);
  const issues = validateConsistency(state.requirements);

  let reply = assistantMessage;
  if (missing.length > 0 && !reply?.trim()) {
    reply = `Mi mancano ancora: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}. Puoi indicarmeli?`;
  } else if (issues.length > 0 && !reply?.trim()) {
    reply = issues.join(' ');
  }

  if (isComplete(state.requirements) && missing.length === 0 && issues.length === 0) {
    state.phase = 'confirming';
    if (!reply?.trim()) {
      reply = `Tutti i dati sono completi!\n\n` +
        `• Destinazione: ${state.requirements.country}\n` +
        `• Partenza da: ${state.requirements.departureAirport}\n` +
        `• Periodo: ${state.requirements.travelMonth} (${state.requirements.durationDays} giorni)\n` +
        `• Partecipanti: ${state.requirements.participants}\n` +
        `• Budget totale: ${state.requirements.budget}€\n` +
        `• Preferenze: ${state.requirements.activityPreferences?.join(', ')}\n\n` +
        `Confermi che vada bene così? (Rispondi "sì" per generare l'itinerario)`;
    } else if (!/rispondi\s+["']?s[ìi]["']?/i.test(reply)) {
      reply = `${reply.trim()}\n\n👉 Rispondi "sì" o "confermo" per generare l'itinerario.`;
    }
  }

  await prisma.conversation.update({ where: { id }, data: { state } });
  await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });

  res.json({ reply, phase: state.phase, requirements: state.requirements, missing, issues });
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      itineraries: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!conversation) {
    return res.status(404).json({ error: 'Conversazione non trovata' });
  }
  const state = normalizeConversationState(conversation.state);
  res.json({ ...conversation, state, status: state.phase });
}));

export default router;
