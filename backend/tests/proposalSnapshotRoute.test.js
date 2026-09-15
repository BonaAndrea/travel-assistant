import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { CircuitOpenError } from '../src/services/llmResilience.js';

const db = {
  conversation: { findUnique: jest.fn(), update: jest.fn() },
  booking: { findMany: jest.fn() },
  destination: { findMany: jest.fn() },
  preferenceImage: { findMany: jest.fn() },
  message: { create: jest.fn() },
  itinerary: { create: jest.fn() },
  $transaction: jest.fn(),
};
const chatTurn = jest.fn();
jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma: db }));
jest.unstable_mockModule('../src/services/llmService.js', () => ({ chatTurn }));
jest.unstable_mockModule('../src/services/preferenceImageService.js', () => ({
  readPreferenceImage: jest.fn().mockResolvedValue(Buffer.from('image')),
  removePreferenceImage: jest.fn(),
  serializePreferenceImage: jest.fn(),
}));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.userId = 'user-1'; next(); },
}));
const { default: chat } = await import('../src/routes/chat.js');
const { default: itineraries } = await import('../src/routes/itineraries.js');
const app = express();
app.use(express.json());
app.use('/chat', chat);
app.use('/itineraries', itineraries);
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));

let conversation;
beforeEach(() => {
  jest.clearAllMocks();
  db.$transaction.mockImplementation((operations) => (
    typeof operations === 'function' ? operations(db) : Promise.all(operations)
  ));
  const requirements = { country: 'Spagna', participants: 2, budget: 5000,
    departureAirport: 'FCO', activityPreferences: ['cultura'], travelMonth: '2030-06', durationDays: 4 };
  conversation = { id: 'conversation-1', userId: 'user-1', messages: [], state: {
    phase: 'itinerary_proposed', requirements,
    lastResult: { requirementsSnapshot: structuredClone(requirements), primary: {
      status: 'ok', totalCost: 1000, breakdown: { flightCost: 400, hotelCost: 500, activityCost: 100 },
      flights: {}, hotel: { hotel: { id: 'hotel-1', name: 'Hotel' }, nights: ['2030-06-01'] }, activities: [],
    } },
  } };
  db.conversation.findUnique.mockImplementation(async () => structuredClone(conversation));
  db.conversation.update.mockImplementation(async ({ data }) => { conversation.state = data.state; return conversation; });
  db.itinerary.create.mockImplementation(async ({ data }) => ({ id: 'draft-1', ...data }));
  db.preferenceImage.findMany.mockResolvedValue([]);
  db.destination.findMany.mockResolvedValue([{
    country: 'Spagna', countryCode: 'ES', city: 'Barcellona', airports: [],
  }]);
  db.booking.findMany.mockResolvedValue([]);
  chatTurn.mockResolvedValue({ assistantMessage: 'Requisiti aggiornati', updatedFields: { participants: 3 } });
});

test('inoltra imageIds autorizzati al turno chat come allegati espliciti', async () => {
  const imageId = '550e8400-e29b-41d4-a716-446655440000';
  db.preferenceImage.findMany.mockResolvedValue([{
    id: imageId, storageKey: 'private.png', mimeType: 'image/png',
  }]);
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Puoi descrivere questo luogo?', imageIds: [imageId] });
  expect(response.status).toBe(200);
  expect(chatTurn).toHaveBeenCalledTimes(1);
  expect(chatTurn.mock.calls[0][4]).toEqual([
    expect.objectContaining({ id: imageId, mimeType: 'image/png', buffer: Buffer.from('image') }),
  ]);
});

test('correction invalidates a proposal and a subsequent save cannot mix old prices with new participants', async () => {
  const correction = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'ok ma siamo 3' });
  expect(correction.status).toBe(200);
  expect(chatTurn).toHaveBeenCalledTimes(1);
  expect(conversation.state.requirements.participants).toBe(3);
  expect(conversation.state.lastResult).toBeUndefined();
  const draft = await request(app).post('/itineraries').send({ conversationId: conversation.id, choice: 'primary' });
  expect(draft.status).toBe(409);
  expect(db.itinerary.create).not.toHaveBeenCalled();
});

test('a negative or qualified confirmation is processed by the LLM even in confirming phase', async () => {
  conversation.state.phase = 'confirming';
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'non confermo' });
  expect(response.status).toBe(200);
  expect(response.body.generationReady).toBeUndefined();
  expect(chatTurn).toHaveBeenCalledTimes(1);
});

test('confirmation resolves Spain aliases before enabling generation', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.country = 'Spain';
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'sì' });
  expect(response.status).toBe(200);
  expect(response.body.generationReady).toBe(true);
  expect(response.body.reply).toContain('avvio la generazione');
  expect(response.body.nextAction).toEqual(expect.objectContaining({
    type: 'start_itinerary_generation', method: 'POST',
    path: '/api/itinerary-jobs', conversationId: conversation.id,
  }));
});

test('la conferma usa sempre un riepilogo deterministico anche con testo LLM', async () => {
  conversation.state.phase = 'collecting';
  conversation.state.requirements = {
    country: 'Spagna', departureAirport: 'FCO', travelMonth: 'giugno', durationDays: 6,
    participants: 2, budget: 5000, activityPreferences: ['cultura'],
  };
  chatTurn.mockResolvedValue({ assistantMessage: 'Perfetto, tutto pronto!', updatedFields: {} });
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'ok' });
  expect(response.body.phase).toBe('confirming');
  expect(response.body.reply).toContain('Riepilogo della richiesta');
  expect(response.body.reply).toContain('Durata: 6 giorni');
  expect(response.body.reply).toContain('Rispondi "sì"');
  expect(response.body.reply).not.toContain('Perfetto, tutto pronto!');
});

test('un intervallo numerico senza mese chiede chiarimento e non inventa la durata', async () => {
  conversation.state.requirements.durationDays = undefined;
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: '1-6' });
  expect(response.status).toBe(200);
  expect(response.body.clarificationRequired).toBe('date_interval');
  expect(response.body.reply).toContain('mese e anno');
  expect(response.body.requirements.durationDays).toBeUndefined();
  expect(chatTurn).not.toHaveBeenCalled();
});

test('blocca anche l’intervallo numerico inserito in una frase del browser', async () => {
  conversation.state.requirements.durationDays = undefined;
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Vorrei viaggiare dal 1-6, magari 6 notti' });
  expect(response.status).toBe(200);
  expect(response.body.clarificationRequired).toBe('date_interval');
  expect(response.body.requirements.durationDays).toBeUndefined();
  expect(chatTurn).not.toHaveBeenCalled();
});

test('espone il preflight overlap in modo non bloccante tra aggiornamento date e conferma', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.outboundDate = '2030-06-01T00:00:00.000Z';
  db.booking.findMany.mockResolvedValue([{
    id: 'booking-madrid',
    itinerary: { details: {
      flights: {
        outbound: { date: '2030-06-01T00:00:00.000Z', destinationAirport: { city: 'Madrid' } },
        inbound: { date: '2030-06-02T00:00:00.000Z' },
      },
      hotel: { nights: ['2030-06-01T00:00:00.000Z'] }, activities: [],
      requirementsSnapshot: { destinationCity: 'Madrid' },
    } },
  }]);
  chatTurn.mockResolvedValue({ assistantMessage: 'Confermi le date?', updatedFields: {
    returnDate: '2030-06-02T00:00:00.000Z',
  } });

  const update = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 2 giugno' });
  expect(update.status).toBe(200);
  expect(update.body.overlapWarning).toEqual(expect.objectContaining({
    code: 'ITINERARY_DATE_CONFLICT', bookingId: 'booking-madrid', destination: 'Madrid',
  }));
  expect(update.body.phase).toBe('confirming');

  const confirmation = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Sì' });
  expect(confirmation.status).toBe(200);
  expect(confirmation.body.generationReady).toBe(true);
  expect(confirmation.body.overlapWarning).toEqual(expect.objectContaining({ code: 'ITINERARY_DATE_CONFLICT' }));
});

test('un vincolo di budget impedisce al messaggio LLM di riaprire il loop di conferma', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.durationDays = 12;
  conversation.state.requirements.budget = 1000;
  chatTurn.mockResolvedValue({ assistantMessage: 'Perfetto, preparo subito l itinerario.', updatedFields: {} });

  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'E torniamo il 13 novembre' });

  expect(response.status).toBe(200);
  expect(response.body.phase).toBe('collecting');
  expect(response.body.reply).toContain('insufficiente');
  expect(response.body.reply).not.toContain('preparo subito');
  expect(response.body.generationReady).toBeUndefined();
});

test('confirmation blocks an unknown destination and keeps generation disabled', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.country = 'Atlantide';
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'sì' });
  expect(response.status).toBe(200);
  expect(response.body.generationReady).toBe(false);
  expect(response.body.reply).toContain('non è riconosciuta dal catalogo');
  expect(chatTurn).not.toHaveBeenCalled();
});

test('explicit return date recalculates duration before the following confirmation', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.durationDays = 7;
  conversation.messages = [{ role: 'user', content: 'Partiamo il 1 novembre' }];
  chatTurn.mockResolvedValue({ assistantMessage: 'Confermi la nuova durata?', updatedFields: {} });

  const update = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Preferisco tornare il 13 novembre' });
  expect(update.status).toBe(200);
  expect(update.body.requirements.returnDate).toBe('2026-11-13T00:00:00.000Z');
  expect(update.body.requirements.outboundDate).toBe('2026-11-01T00:00:00.000Z');
  expect(update.body.requirements.durationDays).toBe(13);

  const confirmation = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'sì' });
  expect(confirmation.status).toBe(200);
  expect(confirmation.body.generationReady).toBe(true);
});

test('explicit December return date updates a November departure across the month boundary', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.durationDays = 7;
  conversation.messages = [{ role: 'user', content: 'Partiamo il 22 novembre' }];
  chatTurn.mockResolvedValue({ assistantMessage: 'Confermi?', updatedFields: {} });
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 6 dicembre' });
  expect(response.body.requirements.returnDate).toBe('2026-12-06T00:00:00.000Z');
  expect(response.body.requirements.durationDays).toBe(15);
});

test('an explicit date range overrides model duration deterministically', async () => {
  conversation.state.phase = 'collecting';
  conversation.state.requirements.durationDays = 35;
  chatTurn.mockResolvedValue({ assistantMessage: 'Date registrate.', updatedFields: { durationDays: 35 } });
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Facciamo 22 novembre - 6 dicembre 2026' });
  expect(response.body.requirements.outboundDate).toBe('2026-11-22T00:00:00.000Z');
  expect(response.body.requirements.returnDate).toBe('2026-12-06T00:00:00.000Z');
  expect(response.body.requirements.durationDays).toBe(15);
});

test('return date recalculates duration and explicit duration wins on the next turn', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.durationDays = 7;
  conversation.messages = [{ role: 'user', content: 'Partiamo il 22 novembre' }];
  chatTurn.mockResolvedValue({ assistantMessage: 'Nuova durata registrata.', updatedFields: {} });

  const first = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 27 novembre' });
  expect(first.body.requirements.durationDays).toBe(6);
  expect(first.body.requirements.returnDate).toBe('2026-11-27T00:00:00.000Z');

  const second = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 27 novembre con una durata totale della vacanza di 5 giorni' });
  expect(second.body.requirements.durationDays).toBe(5);
  expect(second.body.requirements.returnDate).toBe('2026-11-27T00:00:00.000Z');
  expect(second.body.phase).toBe('confirming');
});

test('riconosce il cambio esplicito della data di ritorno con wording alternativo', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.outboundDate = '2026-11-22T00:00:00.000Z';
  conversation.state.requirements.durationDays = 7;
  chatTurn.mockResolvedValue({ assistantMessage: 'Aggiorno la data.', updatedFields: {} });
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Cambio il ritorno al 27 novembre' });
  expect(response.body.requirements.returnDate).toBe('2026-11-27T00:00:00.000Z');
  expect(response.body.requirements.durationDays).toBe(6);
});

test('incoherent explicit dates and duration require clarification without confirmation', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.outboundDate = '2026-11-22T00:00:00.000Z';
  conversation.state.requirements.durationDays = 7;
  chatTurn.mockResolvedValue({ assistantMessage: 'Ho aggiornato la richiesta.', updatedFields: {} });
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 27 novembre con una durata totale della vacanza di 6 giorni' });
  expect(response.body.phase).toBe('collecting');
  expect(response.body.generationReady).toBeUndefined();
  expect(response.body.reply).toContain('non coincide');
});

test('a return date before departure does not overwrite the current duration', async () => {
  conversation.state.phase = 'confirming';
  conversation.state.requirements.outboundDate = '2026-11-22T00:00:00.000Z';
  conversation.state.requirements.durationDays = 7;
  chatTurn.mockResolvedValue({ assistantMessage: 'Indica una data successiva alla partenza.', updatedFields: {} });
  const response = await request(app).post('/chat/conversations/conversation-1/messages')
    .send({ message: 'Torniamo il 13 novembre' });
  expect(response.body.requirements.returnDate).toBeUndefined();
  expect(response.body.requirements.durationDays).toBe(7);
});

test('invalid corrected requirements return to collecting rather than accepting confirmation', async () => {
  conversation.state.phase = 'confirming';
  chatTurn.mockResolvedValue({ assistantMessage: 'Quanti partecipanti?', updatedFields: { participants: null } });
  await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'non so quanti siamo' });
  expect(conversation.state.phase).toBe('collecting');
  expect(conversation.state.lastResult).toBeUndefined();
});

test('provider failure returns a retryable conversational response while preserving requirements', async () => {
  const original = structuredClone(conversation.state);
  chatTurn.mockRejectedValue(new Error('Circuit is open'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'siamo 3' });
    expect(response.status).toBe(200);
    expect(response.body.retryable).toBe(true);
    expect(response.body.reply).toContain('temporaneamente indisponibile');
    expect(response.body.generationReady).toBeUndefined();
    expect(response.body.requirements).toEqual(original.requirements);
    expect(conversation.state).toEqual(original);
    expect(db.conversation.update).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'llm_conversational_fallback', provider: 'groq', error: 'Error',
      errorMessage: 'Circuit is open',
    }));
  } finally {
    warn.mockRestore();
  }
});

test('circuit open espone cooldown e Retry-After senza messaggio generico', async () => {
  chatTurn.mockRejectedValue(new CircuitOpenError(12500));
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'continua' });
  expect(response.status).toBe(200);
  expect(response.body.code).toBe('GROQ_CIRCUIT_OPEN');
  expect(response.body.retryAfterMs).toBe(12500);
  expect(response.headers['retry-after']).toBe('13');
  expect(response.body.reply).toContain('cooldown');
});

test('provider rate limit espone il Retry-After del provider, distinto dal cooldown locale', async () => {
  chatTurn.mockRejectedValue(Object.assign(new Error('Please try again in 5m29.6s.'), { status: 429 }));
  const response = await request(app).post('/chat/conversations/conversation-1/messages').send({ message: 'continua' });
  expect(response.status).toBe(200);
  expect(response.body.code).toBe('GROQ_RATE_LIMITED');
  expect(response.body.retryAfterMs).toBe(329600);
  expect(response.headers['retry-after']).toBe('330');
});

test('draft persists the requirements snapshot that produced its costs', async () => {
  const response = await request(app).post('/itineraries').send({ conversationId: conversation.id, choice: 'primary' });
  expect(response.status).toBe(201);
  expect(response.body.details.participants).toBe(2);
  expect(response.body.details.requirementsSnapshot).toEqual(conversation.state.requirements);
  expect(response.body.totalCost).toBe(1000);
});

test.each(['mismatch', 'missing'])('draft rejects a %s requirements snapshot', async (kind) => {
  if (kind === 'missing') delete conversation.state.lastResult.requirementsSnapshot;
  else conversation.state.lastResult.requirementsSnapshot.participants = 1;
  const response = await request(app).post('/itineraries').send({ conversationId: conversation.id, choice: 'primary' });
  expect(response.status).toBe(409);
  expect(db.itinerary.create).not.toHaveBeenCalled();
});
