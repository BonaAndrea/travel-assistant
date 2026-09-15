import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { chatTurn } from '../services/llmService.js';
import { CircuitOpenError, isTransientGroqError, llmErrorFields, logLlmEvent, retryAfterMsFromError } from '../services/llmResilience.js';
import {
  getMissingFields, validateConsistency, isComplete, normalizeTravelMonth,
  extractExplicitReturnDate, extractExplicitDepartureDate, extractExplicitTravelDates, extractExplicitDuration,
  extractExplicitBudget, extractExplicitParticipants, hasAmbiguousNumericDateInterval,
} from '../services/requirementsService.js';
import { sameRequirements } from '../services/requirementsSnapshot.js';
import { findConfirmedDateConflict } from '../services/bookingService.js';
import { resolveDestinationReference } from '../services/locationNormalization.js';
import { readPreferenceImage, removePreferenceImage, serializePreferenceImage } from '../services/preferenceImageService.js';
import { chatMessageSchema, validationError } from '../validation.js';
import { createConversationLockMiddleware } from '../middleware/conversationLock.js';

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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMPTY_CONVERSATION_STATE = { phase: 'collecting', requirements: {} };

function dateOverlapDestination(details) {
  const snapshot = details?.requirementsSnapshot || {};
  return snapshot.destinationCity || snapshot.country
    || details?.flights?.outbound?.destinationAirport?.city
    || 'destinazione non specificata';
}

async function getDateOverlapWarning(userId, requirements) {
  const departure = new Date(requirements?.outboundDate);
  const returnDate = new Date(requirements?.returnDate);
  if (Number.isNaN(departure.getTime()) || Number.isNaN(returnDate.getTime()) || returnDate <= departure) return undefined;
  try {
    const conflict = await findConfirmedDateConflict(prisma, {
      userId,
      details: { flights: { outbound: { date: departure }, inbound: { date: returnDate } } },
    });
    if (!conflict) return undefined;
    return {
      code: 'ITINERARY_DATE_CONFLICT',
      bookingId: conflict.booking.id,
      dates: {
        start: conflict.existing.start.toISOString(),
        end: conflict.existing.end.toISOString(),
      },
      destination: dateOverlapDestination(conflict.booking.itinerary?.details),
    };
  } catch (error) {
    // Il preflight è solo informativo: un errore DB non deve bloccare chat o generazione.
    logLlmEvent('chat_overlap_preflight_failed', { error: error?.name || 'Error' });
    return undefined;
  }
}

function isConversationId(value) {
  return UUID_PATTERN.test(String(value || ''));
}

function deterministicConfirmationSummary(requirements) {
  const lines = [
    `Destinazione: ${requirements.country || 'da definire'}`,
    `Partenza da: ${requirements.departureAirport || 'da definire'}`,
    `Periodo: ${requirements.travelMonth || 'da definire'}`,
    `Durata: ${requirements.durationDays || 'da definire'} giorni`,
    `Partecipanti: ${requirements.participants || 'da definire'}`,
    `Budget totale: ${requirements.budget || 'da definire'}€`,
    `Preferenze: ${Array.isArray(requirements.activityPreferences) ? requirements.activityPreferences.join(', ') : 'da definire'}`,
  ];
  return `Riepilogo della richiesta:\n\n${lines.map((line) => `• ${line}`).join('\n')}\n\nConfermi questi requisiti? Rispondi "sì" per generare l'itinerario.`;
}

function generationIssueReply(issue) {
  const alternatives = Array.isArray(issue?.alternatives) && issue.alternatives.length > 0
    ? ` Alternative disponibili nel catalogo: ${issue.alternatives.map((alternative) =>
      alternative?.availableReturnDate?.slice?.(0, 10) || alternative?.date?.slice?.(0, 10) || alternative?.city,
    ).filter(Boolean).join(', ')}.`
    : '';
  return `${issue?.message || 'La combinazione richiesta non è disponibile nel catalogo.'} Indica quale requisito vuoi modificare (date, durata, aeroporto, budget o preferenze), così aggiorno la richiesta senza perderne gli altri dati.${alternatives}`;
}

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
    .toLowerCase()
    .trim();

  return /^(?:si|conferma|confermo|ok|vai)[.!]*$/.test(normalized);
}

// Prepara una sessione transitoria. La Conversation viene persistita solo dal
// primo messaggio, così l'apertura della chat non finisce nello storico.
router.post('/conversations', asyncHandler(async (req, res) => {
  res.status(201).json({ conversationId: randomUUID() });
}));

// Elimina una conversazione dell'utente autenticato, lasciando intatti eventuali
// itinerari associati (la relazione è opzionale e viene posta a null).
router.delete('/conversations/:id', asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.userId },
    select: { id: true },
  });
  if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

  const images = await prisma.preferenceImage.findMany({
    where: { conversationId: conversation.id, userId: req.userId },
    select: { storageKey: true },
  });

  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversationId: conversation.id } }),
    prisma.itineraryGenerationJob.deleteMany({
      where: { conversationId: conversation.id, userId: req.userId },
    }),
    prisma.preferenceImage.deleteMany({ where: { conversationId: conversation.id, userId: req.userId } }),
    prisma.conversation.delete({ where: { id: conversation.id } }),
  ]);
  await Promise.all(images.map(({ storageKey }) => removePreferenceImage(storageKey)));
  res.status(204).send();
}));

// Elenco cronologico, paginato e sempre filtrato sull'utente autenticato.
router.get('/conversations', asyncHandler(async (req, res) => {
  const page = parsePositiveInteger(req.query.page, 1);
  const requestedPageSize = parsePositiveInteger(req.query.pageSize, DEFAULT_PAGE_SIZE);
  if (!page || !requestedPageSize) {
    return res.status(400).json({ error: 'page e pageSize devono essere interi positivi' });
  }
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  const where = { userId: req.userId, messages: { some: {} } };
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
        preferenceImages: { orderBy: { createdAt: 'asc' }, select: { id: true, mimeType: true, sizeBytes: true, analysisStatus: true, description: true, tags: true, createdAt: true } },
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
        preferenceImageCount: conversation.preferenceImages?.length || 0,
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

// Invia il primo messaggio creando la Conversation nella stessa transazione.
router.post('/conversations/:id/messages', createConversationLockMiddleware(), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const parsedMessage = chatMessageSchema.safeParse(req.body);
  if (!parsedMessage.success) return res.status(400).json(validationError('Campo "message" non valido', parsedMessage.error));
  const { imageIds } = parsedMessage.data;
  const message = parsedMessage.data.message?.trim()
    || (imageIds.length > 0 ? 'Vorrei usare questa immagine come ispirazione per il viaggio.' : '');
  if (!message) return res.status(400).json(validationError('Campo "message" non valido'));

  const persisted = await prisma.$transaction(async (tx) => {
    const existing = await tx.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        preferenceImages: { orderBy: { createdAt: 'asc' }, select: { id: true, mimeType: true, sizeBytes: true, analysisStatus: true, description: true, tags: true, createdAt: true } },
      },
    });

    if (existing) {
      if (existing.userId !== req.userId) return { conversation: existing, authorized: false };
      await tx.message.create({ data: { conversationId: id, role: 'user', content: message } });
      return { conversation: existing, authorized: true };
    }

    // Solo gli UUID emessi dal POST transitorio possono materializzare una
    // nuova conversazione; gli ID legacy inesistenti restano 404.
    if (!isConversationId(id)) return { conversation: null, authorized: false };

    const created = await tx.conversation.create({
      data: { id, userId: req.userId, state: EMPTY_CONVERSATION_STATE },
    });
    await tx.message.create({ data: { conversationId: id, role: 'user', content: message } });
    return { conversation: { ...created, messages: [], preferenceImages: [] }, authorized: true };
  });

  if (!persisted.authorized) {
    return res.status(404).json({ error: 'Conversazione non trovata' });
  }

  const conversation = persisted.conversation;

  // I dati legacy possono avere uno stato nullo o non conforme: il recupero
  // deve mantenere la stessa normalizzazione usata dallo storico.
  const state = normalizeConversationState(conversation.state);
  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }));
  const preferenceImages = conversation.preferenceImages || [];
  history.push({ role: 'user', content: message });
  const uniqueImageIds = [...new Set(imageIds)];
  let imageAttachments = [];
  if (uniqueImageIds.length > 0) {
    const images = await prisma.preferenceImage.findMany({
      where: { id: { in: uniqueImageIds }, conversationId: id, userId: req.userId },
      select: { id: true, storageKey: true, mimeType: true },
    });
    if (images.length !== uniqueImageIds.length) {
      return res.status(404).json({ code: 'IMAGE_ATTACHMENT_NOT_FOUND', error: 'Immagine allegata non trovata' });
    }
    try {
      imageAttachments = await Promise.all(images.map(async (image) => ({
        id: image.id,
        mimeType: image.mimeType,
        buffer: await readPreferenceImage(image.storageKey),
      })));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(410).json({ code: 'IMAGE_ATTACHMENT_UNAVAILABLE', error: 'Immagine allegata non disponibile' });
      }
      throw error;
    }
  }

  if (hasAmbiguousNumericDateInterval(message)) {
    const reply = 'Ho ricevuto l’intervallo “1-6”, ma senza mese e anno non posso distinguere due date. Indica le date complete (per esempio 1 giugno–6 giugno 2026) oppure specifica la durata in giorni.';
    state.phase = 'collecting';
    await prisma.conversation.update({ where: { id }, data: { state } });
    await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
    return res.json({ reply, phase: state.phase, requirements: state.requirements, clarificationRequired: 'date_interval' });
  }

  // Fase speciale: l'utente sta confermando la generazione dell’itinerario
  if (state.phase === 'confirming' && isConfirmationMessage(message)) {
    if (state.generationIssue) {
      const issue = state.generationIssue;
      const reply = generationIssueReply(issue);
      await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
      return res.json({ reply, phase: state.phase, generationReady: false, generationIssue: issue });
    }
    if (prisma.destination?.findMany && !(await resolveDestinationReference(prisma, state.requirements.country))) {
      const supportedDestinations = await prisma.destination.findMany({
        select: { city: true, country: true },
        orderBy: { city: 'asc' },
        take: 8,
      });
      const alternatives = supportedDestinations.map(({ city, country }) => city || country)
        .filter(Boolean).join(', ');
      const alternativeHint = alternatives ? ` Alternative disponibili: ${alternatives}.` : '';
      const reply = `La destinazione "${state.requirements.country || 'indicata'}" non è riconosciuta dal catalogo. Scegli una città o un paese supportato prima di generare l’itinerario.${alternativeHint}`;
      await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
      return res.json({ reply, phase: state.phase, generationReady: false, requirements: state.requirements });
    }
    const reply = 'Perfetto: avvio la generazione dell’itinerario. Puoi seguire l’avanzamento qui sotto.';
    await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
    const overlapWarning = await getDateOverlapWarning(req.userId, state.requirements);
    return res.json({
      reply,
      phase: state.phase,
      generationReady: true,
      requirements: state.requirements,
      ...(overlapWarning ? { overlapWarning } : {}),
      nextAction: {
        type: 'start_itinerary_generation',
        method: 'POST',
        path: '/api/itinerary-jobs',
        conversationId: id,
        requiresIdempotencyKey: true,
      },
    });
  }

  // Fase normale: raccolta/aggiornamento requisiti via LLM
  let turn;
  try {
    if (uniqueImageIds.length > 0) {
      turn = state.generationIssue
        ? await chatTurn(history, state.requirements, state.phase, preferenceImages, imageAttachments, state.generationIssue)
        : await chatTurn(history, state.requirements, state.phase, preferenceImages, imageAttachments);
    } else {
      turn = state.generationIssue
        ? await chatTurn(history, state.requirements, state.phase, preferenceImages, [], state.generationIssue)
        : await chatTurn(history, state.requirements, state.phase, preferenceImages);
    }
  } catch (error) {
    logLlmEvent('llm_conversational_fallback', {
      ...llmErrorFields(error),
    });
    const retryAfterMs = error instanceof CircuitOpenError
      ? error.retryAfterMs
      : (isTransientGroqError(error) ? (retryAfterMsFromError(error) || 1000) : undefined);
    if (Number.isFinite(retryAfterMs)) res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    const cooldown = error instanceof CircuitOpenError;
    const reply = 'Il servizio di assistenza è temporaneamente indisponibile. I dati del viaggio sono rimasti invariati: riprova tra poco per aggiornarli.';
    await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });
    return res.json({ code: cooldown ? error.code : (error?.status === 429 ? 'GROQ_RATE_LIMITED' : 'GROQ_PROVIDER_UNAVAILABLE'), reply: cooldown
      ? 'Il servizio di assistenza è in pausa per un breve cooldown. Riprova tra poco.' : reply,
      phase: state.phase, requirements: state.requirements,
      missing: getMissingFields(state.requirements), issues: validateConsistency(state.requirements),
      retryable: true, ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) });
  }
  const { assistantMessage, updatedFields } = turn;
  const normalizedFields = { ...updatedFields };
  if (Object.hasOwn(normalizedFields, 'travelMonth')) {
    const month = normalizeTravelMonth(normalizedFields.travelMonth);
    if (month) normalizedFields.travelMonth = month;
    else delete normalizedFields.travelMonth;
  }
  const explicitTravelDates = extractExplicitTravelDates(message);
  const explicitDuration = extractExplicitDuration(message);
  const explicitBudget = extractExplicitBudget(message);
  const explicitParticipants = extractExplicitParticipants(message);
  if (explicitBudget !== null) normalizedFields.budget = explicitBudget;
  if (explicitParticipants !== null) normalizedFields.participants = explicitParticipants;
  let dateDurationConflict = false;
  if (explicitTravelDates && explicitTravelDates.returnDate > explicitTravelDates.departure) {
    normalizedFields.outboundDate = explicitTravelDates.departure.toISOString();
    normalizedFields.returnDate = explicitTravelDates.returnDate.toISOString();
    normalizedFields.durationDays = Math.round(
      (explicitTravelDates.returnDate.getTime() - explicitTravelDates.departure.getTime()) / 86400000,
    ) + 1;
    normalizedFields.travelMonth = normalizeTravelMonth(
      explicitTravelDates.departure.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
    );
  } else {
    const explicitReturnDate = extractExplicitReturnDate(message);
    if (!explicitReturnDate) {
      // Nessuna data esplicita: i campi estratti dal modello restano invariati.
    } else {
    const departureDate = normalizedFields.outboundDate
      || state.requirements.outboundDate
      || extractExplicitDepartureDate(history.slice(0, -1));
    let returnDate = explicitReturnDate;
    const departure = departureDate ? new Date(departureDate) : null;
    if (departure && !Number.isNaN(departure.getTime()) && returnDate <= departure
      && returnDate.getUTCMonth() < departure.getUTCMonth()) {
      // Un mese numericamente precedente indica il rientro nell'anno seguente
      // (es. partenza dicembre, rientro gennaio).
      returnDate = new Date(returnDate);
      returnDate.setUTCFullYear(returnDate.getUTCFullYear() + 1);
    }
    const validAfterDeparture = !departure || Number.isNaN(departure.getTime()) || returnDate > departure;
    if (validAfterDeparture) normalizedFields.returnDate = returnDate.toISOString();
    if (validAfterDeparture && departure) {
      const durationDays = Math.round((returnDate.getTime() - departure.getTime()) / 86400000) + 1;
      if (Number.isFinite(durationDays) && durationDays > 0) {
        normalizedFields.outboundDate = departure.toISOString();
        normalizedFields.durationDays = durationDays;
      }
    }
    }
  }
  if (explicitDuration && !explicitTravelDates) {
    const departureDate = normalizedFields.outboundDate || state.requirements.outboundDate
      || extractExplicitDepartureDate(history.slice(0, -1));
    const returnDate = normalizedFields.returnDate || state.requirements.returnDate;
    normalizedFields.durationDays = explicitDuration;
    if (departureDate && returnDate) {
      const calendarDuration = Math.round((new Date(returnDate).getTime() - new Date(departureDate).getTime()) / 86400000);
      dateDurationConflict = calendarDuration !== explicitDuration;
    }
  }
  const requirements = { ...state.requirements, ...normalizedFields };
  if (!sameRequirements(state.requirements, requirements)) delete state.lastResult;
  if (Object.keys(normalizedFields).length > 0) delete state.generationIssue;
  state.requirements = requirements;
  state.phase = 'collecting';

  const missing = getMissingFields(state.requirements);
  const issues = validateConsistency(state.requirements);
  const overlapWarning = await getDateOverlapWarning(req.userId, state.requirements);

  let reply = assistantMessage;
  if (missing.length > 0 && !reply?.trim()) {
    reply = `Mi mancano ancora: ${missing.map((f) => FIELD_LABELS[f]).join(', ')}. Puoi indicarmeli?`;
  } else if (issues.length > 0) {
    // Il modello può dichiararsi pronto anche quando i vincoli deterministici
    // tengono la conversazione in collecting. Non lasciare un messaggio che
    // inviti alla conferma, altrimenti i successivi "sì" entrano in un loop.
    reply = issues.join(' ');
  }

  if (dateDurationConflict) {
    state.phase = 'collecting';
    reply = 'La durata indicata non coincide con le date di partenza e ritorno. Conferma quale dato devo correggere: le date oppure il numero di giorni.';
  } else if (isComplete(state.requirements) && missing.length === 0 && issues.length === 0) {
    state.phase = 'confirming';
    reply = deterministicConfirmationSummary(state.requirements);
  }

  await prisma.conversation.update({ where: { id }, data: { state } });
  await prisma.message.create({ data: { conversationId: id, role: 'assistant', content: reply } });

  res.json({ reply, phase: state.phase, requirements: state.requirements, missing, issues,
    ...(overlapWarning ? { overlapWarning } : {}) });
}));

router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      preferenceImages: { orderBy: { createdAt: 'asc' }, select: { id: true, conversationId: true, originalName: true, mimeType: true, sizeBytes: true, analysisStatus: true, description: true, tags: true, createdAt: true } },
      itineraries: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!conversation) {
    // Gli ID restituiti dal POST iniziale sono transitori e non hanno ancora
    // una riga DB. Restituiamo lo stato vuoto senza materializzarlo.
    if (isConversationId(req.params.id)) {
      return res.json({
        id: req.params.id,
        state: EMPTY_CONVERSATION_STATE,
        status: EMPTY_CONVERSATION_STATE.phase,
        createdAt: null,
        updatedAt: null,
        messages: [],
        preferenceImages: [],
        itineraries: [],
      });
    }
    return res.status(404).json({ error: 'Conversazione non trovata' });
  }
  const state = normalizeConversationState(conversation.state);
  res.json({
    id: conversation.id,
    state,
    status: state.phase,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages,
    preferenceImages: (conversation.preferenceImages || []).map(serializePreferenceImage),
    itineraries: conversation.itineraries,
  });
}));

export default router;
