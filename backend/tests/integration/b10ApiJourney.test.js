import { beforeEach, afterAll, expect, jest, test } from '@jest/globals';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
  || database.hostname !== '127.0.0.1' || database.pathname !== '/travel_assistant_test'
  || database.username !== 'travel_test') {
  throw new Error('Use npm run test:integration to provision an isolated test database');
}

// Provider conversazionale deterministico: l'API, il DB e il job restano reali.
const chatTurn = jest.fn();
const generateItinerary = jest.fn();
jest.unstable_mockModule('../../src/services/llmService.js', () => ({ chatTurn }));
jest.unstable_mockModule('../../src/services/itineraryService.js', () => ({ generateItinerary }));

const { default: app } = await import('../../src/app.js');
const { prisma } = await import('../../src/db/prisma.js');

beforeEach(async () => {
  for (const model of ['booking', 'itineraryGenerationJob', 'itinerary', 'message', 'conversation', 'refreshToken',
    'user', 'hotelAvailability', 'activityAvailability', 'flight', 'hotel', 'activity', 'airport', 'destination']) {
    await prisma[model].deleteMany();
  }
  jest.clearAllMocks();
});

afterAll(async () => { await prisma.$disconnect(); });

async function waitForJob(token, jobId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await request(app).get(`/api/itinerary-jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    if (['completed', 'failed'].includes(response.body.job.status)) return response.body.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timeout polling job');
}

test('B10 API completo con provider LLM deterministico', async () => {
  const email = `${randomUUID()}@example.test`;
  const registration = await request(app).post('/api/auth/register')
    .send({ email, password: 'secret1', name: 'B10 API Test' });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const firstRequirements = {
    country: 'Test', departureAirport: 'AAA', activityPreferences: ['culture'],
    travelMonth: 'giugno', durationDays: 1, participants: 1,
  };
  chatTurn.mockImplementation(async (history, requirements) => {
    const userTurns = history.filter(({ role }) => role === 'user').length;
    return requirements.budget === undefined && userTurns === 1
      ? { assistantMessage: 'Qual è il budget?', updatedFields: firstRequirements }
      : { assistantMessage: 'Tutti i dati sono completi. Confermi?', updatedFields: { budget: 500 } };
  });

  const prepared = await request(app).post('/api/chat/conversations').set(auth).send();
  expect(prepared.status).toBe(201);
  const conversationId = prepared.body.conversationId;

  const turnOne = await request(app).post(`/api/chat/conversations/${conversationId}/messages`)
    .set(auth).send({ message: 'Vorrei andare a Test, partenza AAA, giugno, un giorno, una persona e cultura.' });
  expect(turnOne.status).toBe(200);
  expect(turnOne.body.phase).toBe('collecting');

  const turnTwo = await request(app).post(`/api/chat/conversations/${conversationId}/messages`)
    .set(auth).send({ message: 'Budget 500 euro.' });
  expect(turnTwo.status).toBe(200);
  expect(turnTwo.body.phase).toBe('confirming');
  expect(chatTurn).toHaveBeenCalledTimes(2);

  // La conferma ora richiede che la destinazione sia presente nel catalogo.
  const destination = await prisma.destination.create({ data: { country: 'Test', city: 'Test City' } });

  const confirmation = await request(app).post(`/api/chat/conversations/${conversationId}/messages`)
    .set(auth).send({ message: 'si' });
  expect(confirmation.status).toBe(200);
  expect(confirmation.body.generationReady).toBe(true);

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const origin = await prisma.airport.create({ data: { iataCode: 'AAA', name: 'Origin', city: 'Origin', countryCode: 'IT' } });
  const target = await prisma.airport.create({ data: {
    iataCode: 'BBB', name: 'Target', city: 'Test City', countryCode: 'IT', destinationId: destination.id,
  } });
  const outbound = await prisma.flight.create({ data: {
    originAirportId: origin.id, destinationAirportId: target.id, direction: 'outbound',
    date: new Date('2030-06-01T00:00:00.000Z'), seatsAvailable: 1, cost: 100,
  } });
  const inbound = await prisma.flight.create({ data: {
    originAirportId: target.id, destinationAirportId: origin.id, direction: 'return',
    date: new Date('2030-06-02T00:00:00.000Z'), seatsAvailable: 1, cost: 100,
  } });
  const hotel = await prisma.hotel.create({ data: { name: 'Hotel Test', destinationId: destination.id, country: 'Test', city: 'Test City' } });
  const night = new Date('2030-06-01T00:00:00.000Z');
  await prisma.hotelAvailability.create({ data: { hotelId: hotel.id, date: night, pricePerNight: 100, roomsAvailable: 1 } });

  const option = {
    status: 'ok', totalCost: 300, withinBudget: true, compromises: [],
    flights: { outbound: { id: outbound.id }, inbound: { id: inbound.id } },
    hotel: { hotel: { id: hotel.id, name: hotel.name }, nights: [night.toISOString()] },
    activities: [], breakdown: { flightCost: 200, hotelCost: 100, activityCost: 0 },
  };
  generateItinerary.mockResolvedValue({ primary: option, alternative: null });

  const jobResponse = await request(app).post('/api/itinerary-jobs').set(auth)
    .send({ conversationId, idempotencyKey: randomUUID() });
  expect(jobResponse.status).toBe(202);
  const job = await waitForJob(token, jobResponse.body.job.id);
  expect(job.status).toBe('completed');
  expect(job.result.primary.status).toBe('ok');

  const proposed = await request(app).get(`/api/chat/conversations/${conversationId}`).set(auth);
  expect(proposed.status).toBe(200);
  expect(proposed.body.status).toBe('itinerary_proposed');

  const draftOne = await request(app).post('/api/itineraries').set(auth)
    .send({ conversationId, choice: 'primary' });
  expect(draftOne.status).toBe(201);
  const draftTwo = await request(app).post('/api/itineraries').set(auth)
    .send({ conversationId, choice: 'primary' });
  expect(draftTwo.status).toBe(201);

  const bookingRequest = { itineraryId: draftOne.body.id, idempotencyKey: randomUUID(), confirm: true };
  const bookingResponse = await request(app).post('/api/bookings').set(auth).send(bookingRequest);
  expect(bookingResponse.status).toBe(201);
  const bookingId = bookingResponse.body.booking.id;
  const replay = await request(app).post('/api/bookings').set(auth).send(bookingRequest);
  expect(replay.status).toBe(200);
  expect(replay.body.alreadyProcessed).toBe(true);

  const listed = await request(app).get('/api/bookings').set(auth);
  expect(listed.status).toBe(200);
  expect(listed.body).toHaveLength(1);

  const modified = await request(app).patch(`/api/bookings/${bookingId}`).set(auth)
    .send({ newItineraryId: draftTwo.body.id });
  expect(modified.status).toBe(200);
  expect(modified.body.booking.itineraryId).toBe(draftTwo.body.id);

  const cancelled = await request(app).delete(`/api/bookings/${bookingId}`).set(auth)
    .send({ reason: 'Test B10' });
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.booking.status).toBe('cancelled');
  expect((await prisma.flight.findUnique({ where: { id: outbound.id } })).seatsAvailable).toBe(1);
  expect((await prisma.hotelAvailability.findUnique({ where: { hotelId_date: { hotelId: hotel.id, date: night } } })).roomsAvailable).toBe(1);
});
