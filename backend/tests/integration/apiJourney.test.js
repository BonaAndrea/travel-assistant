import { beforeEach, afterAll, expect, test } from '@jest/globals';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
  || database.hostname !== '127.0.0.1' || database.pathname !== '/travel_assistant_test'
  || database.username !== 'travel_test') {
  throw new Error('Use npm run test:integration to provision an isolated test database');
}

const { default: app } = await import('../../src/app.js');
const { prisma } = await import('../../src/db/prisma.js');

beforeEach(async () => {
  for (const model of ['booking', 'itineraryGenerationJob', 'itinerary', 'message', 'conversation', 'refreshToken',
    'user', 'hotelAvailability', 'activityAvailability', 'flight', 'hotel', 'activity', 'airport', 'destination']) {
    await prisma[model].deleteMany();
  }
});

afterAll(async () => { await prisma.$disconnect(); });

test('percorso API autenticato completo su PostgreSQL isolato', async () => {
  const email = `${randomUUID()}@example.test`;
  const requirements = {
    budget: 500, country: 'Test', departureAirport: 'AAA', activityPreferences: ['culture'],
    travelMonth: 'giugno', durationDays: 1, participants: 1,
  };

  const registration = await request(app).post('/api/auth/register').send({ email, password: 'secret1', name: 'E2E Test' });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  expect(token).toBeTruthy();

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, state: { phase: 'collecting', requirements: {} } },
  });
  const conversationId = conversation.id;
  const destination = await prisma.destination.create({ data: { country: 'Test', city: 'Test City' } });
  const origin = await prisma.airport.create({ data: { iataCode: 'AAA', name: 'Origin', city: 'Origin', countryCode: 'IT' } });
  const target = await prisma.airport.create({ data: {
    iataCode: 'BBB', name: 'Target', city: 'Test City', countryCode: 'IT', destinationId: destination.id,
  } });
  const date = new Date('2030-06-01T00:00:00.000Z');
  const outbound = await prisma.flight.create({ data: {
    originAirportId: origin.id, destinationAirportId: target.id, direction: 'outbound', date, seatsAvailable: 1, cost: 100,
  } });
  const inbound = await prisma.flight.create({ data: {
    originAirportId: target.id, destinationAirportId: origin.id, direction: 'return', date: new Date('2030-06-02T00:00:00.000Z'), seatsAvailable: 1, cost: 100,
  } });
  const hotel = await prisma.hotel.create({ data: { name: 'Hotel Test', destinationId: destination.id, country: 'Test', city: 'Test City' } });
  await prisma.hotelAvailability.create({ data: { hotelId: hotel.id, date, pricePerNight: 100, roomsAvailable: 1 } });
  const activity = await prisma.activity.create({ data: { name: 'Museum', destinationId: destination.id, country: 'Test', city: 'Test City', category: 'culture' } });
  await prisma.activityAvailability.create({ data: { activityId: activity.id, date, cost: 10, capacity: 1 } });

  const option = {
    status: 'ok', totalCost: 310, breakdown: { flightCost: 200, hotelCost: 100, activityCost: 10 }, compromises: [],
    flights: { outbound, inbound }, hotel: { hotel, nights: [date.toISOString()] },
    activities: [{ activityId: activity.id, date: date.toISOString(), name: 'Museum', cost: 10 }],
  };
  await prisma.conversation.update({ where: { id: conversationId }, data: {
    state: { phase: 'itinerary_proposed', requirements, lastResult: { requirementsSnapshot: requirements, primary: option } },
  } });

  const draft = await request(app).post('/api/itineraries').set('Authorization', `Bearer ${token}`)
    .send({ conversationId, choice: 'primary' });
  expect(draft.status).toBe(201);
  expect(draft.body.details.requirementsSnapshot).toEqual(requirements);

  const booking = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`)
    .send({ itineraryId: draft.body.id, idempotencyKey: randomUUID(), confirm: true });
  expect(booking.status).toBe(201);
  expect(booking.body.booking.status).toBe('confirmed');

  const overlappingDraft = await prisma.itinerary.create({
    data: {
      userId: user.id,
      status: 'draft',
      totalCost: draft.body.totalCost,
      flightCost: draft.body.flightCost,
      hotelCost: draft.body.hotelCost,
      activityCost: draft.body.activityCost,
      details: draft.body.details,
    },
  });
  const overlapBooking = await request(app).post('/api/bookings').set('Authorization', `Bearer ${token}`)
    .send({ itineraryId: overlappingDraft.id, idempotencyKey: randomUUID(), confirm: true });
  expect(overlapBooking.status).toBe(409);
  expect(overlapBooking.body.code).toBe('ITINERARY_DATE_CONFLICT');
  expect(await prisma.booking.count({ where: { userId: user.id, status: 'confirmed' } })).toBe(1);
  expect(await prisma.booking.count({ where: { userId: user.id, status: 'failed' } })).toBe(0);

  const listed = await request(app).get('/api/bookings').set('Authorization', `Bearer ${token}`);
  expect(listed.status).toBe(200);
  expect(listed.body).toHaveLength(1);
  expect((await prisma.user.count())).toBe(1);
  expect((await prisma.flight.findUnique({ where: { id: outbound.id } })).seatsAvailable).toBe(0);
  expect((await prisma.flight.findUnique({ where: { id: inbound.id } })).seatsAvailable).toBe(0);
  expect((await prisma.hotelAvailability.findFirst()).roomsAvailable).toBe(0);
  expect((await prisma.activityAvailability.findFirst()).booked).toBe(1);
  expect(user.id).toBeTruthy();
});

test('apertura senza invio non persiste, il primo invio materializza un solo storico', async () => {
  const email = `${randomUUID()}@example.test`;
  const registration = await request(app).post('/api/auth/register')
    .send({ email, password: 'secret1', name: 'Lazy Conversation Test' });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const legacyEmpty = await prisma.conversation.create({
    data: { userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id,
      state: { phase: 'collecting', requirements: {} } },
  });
  const legacyHistory = await request(app).get('/api/chat/conversations').set(auth);
  expect(legacyHistory.status).toBe(200);
  expect(legacyHistory.body.pagination.totalItems).toBe(0);

  const prepared = await request(app).post('/api/chat/conversations').set(auth).send();
  expect(prepared.status).toBe(201);
  const conversationId = prepared.body.conversationId;
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  expect(await prisma.conversation.count({ where: { userId: user.id } })).toBe(1);

  const empty = await request(app).get(`/api/chat/conversations/${conversationId}`).set(auth);
  expect(empty.status).toBe(200);
  expect(empty.body.messages).toEqual([]);
  expect(await prisma.conversation.count({ where: { userId: user.id } })).toBe(1);

  const firstMessage = await request(app).post(`/api/chat/conversations/${conversationId}/messages`)
    .set(auth).send({ message: 'Ciao' });
  expect(firstMessage.status).toBe(200);

  const persisted = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: true },
  });
  expect(persisted.userId).toBe(user.id);
  expect(persisted.messages.map(({ role }) => role)).toEqual(expect.arrayContaining(['user', 'assistant']));
  expect(legacyEmpty.id).not.toBe(conversationId);

  const history = await request(app).get('/api/chat/conversations').set(auth);
  expect(history.status).toBe(200);
  expect(history.body.pagination.totalItems).toBe(1);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0].id).toBe(conversationId);
});

test('DELETE conversazione autentica rimuove messaggi/job ma conserva gli itinerari scollegati', async () => {
  const email = `${randomUUID()}@example.test`;
  const registration = await request(app).post('/api/auth/register')
    .send({ email, password: 'secret1', name: 'Delete Test' });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, state: { phase: 'collecting', requirements: {} } },
  });
  const conversationId = conversation.id;

  await prisma.message.create({ data: { conversationId, role: 'user', content: 'Ciao' } });
  await prisma.itineraryGenerationJob.create({
    data: {
      userId: user.id,
      conversationId,
      idempotencyKey: randomUUID(),
      result: { requirementsSnapshot: {} },
    },
  });
  const itinerary = await prisma.itinerary.create({
    data: {
      userId: user.id,
      conversationId,
      details: {},
      totalCost: 0,
      flightCost: 0,
      hotelCost: 0,
      activityCost: 0,
    },
  });

  const deleted = await request(app).delete(`/api/chat/conversations/${conversationId}`).set(auth);
  expect(deleted.status).toBe(204);
  expect(await prisma.conversation.findUnique({ where: { id: conversationId } })).toBeNull();
  expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  expect(await prisma.itineraryGenerationJob.count({ where: { conversationId } })).toBe(0);
  expect((await prisma.itinerary.findUnique({ where: { id: itinerary.id } })).conversationId).toBeNull();

  const missing = await request(app).delete(`/api/chat/conversations/${conversationId}`).set(auth);
  expect(missing.status).toBe(404);
});
