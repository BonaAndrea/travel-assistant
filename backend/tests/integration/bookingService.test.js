import { beforeAll, beforeEach, afterAll, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';

// Refuse direct execution against application databases, including .env defaults.
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
    || database.hostname !== '127.0.0.1'
    || database.pathname !== '/travel_assistant_test'
    || database.username !== 'travel_test') {
  throw new Error('Use node scripts/run-integration-tests.js to provision an isolated test database');
}

const { prisma } = await import('../../src/db/prisma.js');
const { confirmBooking, cancelBooking, modifyBooking } = await import('../../src/services/bookingService.js');
const date = new Date('2030-06-01T00:00:00.000Z');
let fixture;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });

beforeEach(async () => {
  for (const model of ['booking', 'itinerary', 'message', 'conversation', 'user', 'hotelAvailability',
    'activityAvailability', 'flight', 'hotel', 'activity', 'airport', 'destination']) {
    await prisma[model].deleteMany();
  }
  const user = await prisma.user.create({ data: { email: 'integration@example.test', name: 'Test', passwordHash: 'unused' } });
  const destination = await prisma.destination.create({ data: { country: 'Test', city: 'Test City' } });
  const origin = await prisma.airport.create({ data: { iataCode: 'AAA', name: 'Origin', city: 'Origin', countryCode: 'IT' } });
  const target = await prisma.airport.create({ data: { iataCode: 'BBB', name: 'Target', city: 'Target', countryCode: 'IT' } });
  const flights = [];
  for (const direction of ['outbound', 'return']) {
    flights.push(await prisma.flight.create({ data: {
      originAirportId: direction === 'outbound' ? origin.id : target.id,
      destinationAirportId: direction === 'outbound' ? target.id : origin.id,
      direction, date, seatsAvailable: 2, cost: 50,
    } }));
  }
  const hotel = await prisma.hotel.create({ data: { name: 'Hotel', destinationId: destination.id, country: 'Test', city: 'Test City' } });
  await prisma.hotelAvailability.create({ data: { hotelId: hotel.id, date, pricePerNight: 100, roomsAvailable: 1 } });
  const activity = await prisma.activity.create({ data: { name: 'Museum', destinationId: destination.id, country: 'Test', city: 'Test City', category: 'culture' } });
  const activitySlot = await prisma.activityAvailability.create({
    data: { activityId: activity.id, date, cost: 10, capacity: 2, startMinute: 9 * 60, endMinute: 11 * 60 },
  });
  fixture = { userId: user.id, flights, hotel, activity, activitySlot };
});

async function itinerary(overrides = {}) {
  return prisma.itinerary.create({ data: {
    userId: fixture.userId, totalCost: 320, flightCost: 200, hotelCost: 100, activityCost: 20,
    details: {
      participants: 2,
      flights: { outbound: { id: fixture.flights[0].id }, inbound: { id: fixture.flights[1].id } },
      hotel: { id: fixture.hotel.id, nights: [date.toISOString()] },
      activities: [{ activityId: fixture.activity.id, date: date.toISOString(), name: 'Museum' }],
      ...overrides,
    },
  } });
}

function confirm(draft, key = randomUUID()) {
  return confirmBooking({ userId: fixture.userId, itineraryId: draft.id, idempotencyKey: key });
}

async function expectInventory(seats, rooms, booked) {
  expect((await prisma.flight.findMany()).map(flight => flight.seatsAvailable)).toEqual([seats, seats]);
  expect((await prisma.hotelAvailability.findFirst()).roomsAvailable).toBe(rooms);
  expect((await prisma.activityAvailability.findFirst()).booked).toBe(booked);
}

test('confirmation reserves every resource and sequential retry returns the same booking', async () => {
  const draft = await itinerary();
  const key = randomUUID();
  const first = await confirm(draft, key);
  expect(first.booking.status).toBe('confirmed');
  expect((await confirm(draft, key)).booking.id).toBe(first.booking.id);
  expect((await confirm(draft, key)).alreadyProcessed).toBe(true);
  expect(await prisma.booking.count()).toBe(1);
  expect((await prisma.itinerary.findUnique({ where: { id: draft.id } })).status).toBe('confirmed');
  await expectInventory(0, 0, 2);
});

test('conferma rifiuta date sovrapposte a una prenotazione confermata', async () => {
  const confirmed = await itinerary({
    flights: {
      outbound: { id: fixture.flights[0].id, date: '2030-06-01T00:00:00.000Z' },
      inbound: { id: fixture.flights[1].id, date: '2030-06-02T00:00:00.000Z' },
    },
  });
  await confirm(confirmed);

  const overlapping = await itinerary({
    flights: {
      outbound: { id: fixture.flights[0].id, date: '2030-06-02T00:00:00.000Z' },
      inbound: { id: fixture.flights[1].id, date: '2030-06-03T00:00:00.000Z' },
    },
    hotel: { id: fixture.hotel.id, nights: ['2030-06-02T00:00:00.000Z'] },
  });

  await expect(confirm(overlapping)).rejects.toMatchObject({
    code: 'ITINERARY_DATE_CONFLICT', status: 409,
  });
  expect(await prisma.booking.count({ where: { status: 'confirmed' } })).toBe(1);
});

test('confirmation reserves only the selected activity slot when a day has multiple slots', async () => {
  const secondSlot = await prisma.activityAvailability.create({
    data: {
      activityId: fixture.activity.id,
      date,
      cost: 12,
      capacity: 2,
      startMinute: 12 * 60,
      endMinute: 14 * 60,
    },
  });
  const draft = await itinerary({
    activities: [{
      activityId: fixture.activity.id,
      availabilityId: fixture.activitySlot.id,
      date: date.toISOString(),
      name: 'Museum',
    }],
  });

  const result = await confirm(draft);
  expect(result.booking.status).toBe('confirmed');
  expect((await prisma.activityAvailability.findUnique({ where: { id: fixture.activitySlot.id } })).booked).toBe(2);
  expect((await prisma.activityAvailability.findUnique({ where: { id: secondSlot.id } })).booked).toBe(0);
});

test('activity exhaustion rolls back previously reserved flights and hotel', async () => {
  const draft = await itinerary();
  await prisma.activityAvailability.updateMany({ data: { capacity: 1 } });
  const result = await confirm(draft);
  expect(result.booking.status).toBe('failed');
  expect(result.error).toBeTruthy();
  expect((await prisma.itinerary.findUnique({ where: { id: draft.id } })).status).toBe('draft');
  await expectInventory(2, 1, 0);
});

test('a failed confirmation remains idempotent when retried', async () => {
  const draft = await itinerary();
  await prisma.activityAvailability.updateMany({ data: { capacity: 1 } });
  const key = randomUUID();
  const first = await confirm(draft, key);
  const retry = await confirm(draft, key);
  expect(first.booking.status).toBe('failed');
  expect(retry.booking.id).toBe(first.booking.id);
  expect(retry.alreadyProcessed).toBe(true);
  expect(await prisma.booking.count()).toBe(1);
  await expectInventory(2, 1, 0);
});

test('idempotency keys cannot return bookings belonging to another user or itinerary', async () => {
  const draft = await itinerary();
  const otherDraft = await itinerary();
  const key = randomUUID();
  await confirm(draft, key);
  await expect(confirmBooking({ userId: randomUUID(), itineraryId: draft.id,
    idempotencyKey: key })).rejects.toThrow();
  await expect(confirm(otherDraft, key)).rejects.toThrow();
  await expectInventory(0, 0, 2);
});

test('simultaneous retries with the same key return one confirmed booking', async () => {
  const draft = await itinerary();
  const key = randomUUID();
  const results = await Promise.all([confirm(draft, key), confirm(draft, key)]);
  expect(results.every(result => result.booking.status === 'confirmed')).toBe(true);
  expect(new Set(results.map(result => result.booking.id)).size).toBe(1);
  expect(await prisma.booking.count()).toBe(1);
  await expectInventory(0, 0, 2);
});

test('different keys cannot confirm the same draft twice even with spare inventory', async () => {
  const draft = await itinerary();
  await prisma.flight.updateMany({ data: { seatsAvailable: 4 } });
  await prisma.hotelAvailability.updateMany({ data: { roomsAvailable: 2 } });
  await prisma.activityAvailability.updateMany({ data: { capacity: 4 } });
  const outcomes = await Promise.allSettled([confirm(draft), confirm(draft)]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled'
    && outcome.value.booking.status === 'confirmed')).toHaveLength(1);
  expect(await prisma.booking.count({ where: { status: 'confirmed' } })).toBe(1);
  await expectInventory(2, 1, 2);
});

test('concurrent requests for the last seats cannot overbook', async () => {
  const drafts = await Promise.all([itinerary(), itinerary()]);
  const results = await Promise.all(drafts.map(draft => confirm(draft)));
  expect(results.map(result => result.booking.status).sort()).toEqual(['confirmed', 'failed']);
  expect(await prisma.itinerary.count({ where: { status: 'confirmed' } })).toBe(1);
  await expectInventory(0, 0, 2);
});

test('cancellation restores inventory and a repeated cancellation cannot release twice', async () => {
  const result = await confirm(await itinerary());
  const request = { userId: fixture.userId, bookingId: result.booking.id, reason: 'Changed plans' };
  const cancelled = await cancelBooking(request);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.cancelledAt).toBeInstanceOf(Date);
  expect(cancelled.itinerary.status).toBe('cancelled');
  expect(cancelled.cancellationReason).toBe('Changed plans');
  await expect(cancelBooking(request)).rejects.toThrow();
  await expectInventory(2, 1, 0);
});

test('concurrent cancellations release inventory exactly once', async () => {
  const result = await confirm(await itinerary());
  const request = { userId: fixture.userId, bookingId: result.booking.id };
  const outcomes = await Promise.allSettled([cancelBooking(request), cancelBooking(request)]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  await expectInventory(2, 1, 0);
});

test('failed modification restores the original confirmed reservation atomically', async () => {
  const original = await itinerary();
  const result = await confirm(original);
  const replacement = await itinerary({ participants: 3 });
  await expect(modifyBooking({ userId: fixture.userId, bookingId: result.booking.id,
    newItineraryId: replacement.id })).rejects.toThrow();
  expect((await prisma.booking.findUnique({ where: { id: result.booking.id } })).itineraryId).toBe(original.id);
  expect((await prisma.itinerary.findUnique({ where: { id: original.id } })).status).toBe('confirmed');
  expect((await prisma.itinerary.findUnique({ where: { id: replacement.id } })).status).toBe('draft');
  await expectInventory(0, 0, 2);
});

test('confirmation updates conversation phase atomically and preserves its requirements', async () => {
  const state = { phase: 'itinerary_proposed', requirements: { participants: 2 }, lastResult: { marker: true } };
  const conversation = await prisma.conversation.create({ data: { userId: fixture.userId, state } });
  const draft = await itinerary({ requirementsSnapshot: state.requirements });
  await prisma.itinerary.update({ where: { id: draft.id }, data: { conversationId: conversation.id } });
  const result = await confirm(draft);
  expect(result.booking.status).toBe('confirmed');
  expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).state)
    .toEqual({ ...state, phase: 'booking_confirmed' });
});

test('failed booking leaves conversation proposed and a newer collection is not overwritten', async () => {
  const state = { phase: 'itinerary_proposed', requirements: { participants: 2 } };
  const conversation = await prisma.conversation.create({ data: { userId: fixture.userId, state } });
  const draft = await itinerary();
  await prisma.itinerary.update({ where: { id: draft.id }, data: { conversationId: conversation.id } });
  await prisma.activityAvailability.updateMany({ data: { capacity: 1 } });
  expect((await confirm(draft)).booking.status).toBe('failed');
  expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).state).toEqual(state);
  const changed = { phase: 'collecting', requirements: { participants: 3 } };
  await prisma.conversation.update({ where: { id: conversation.id }, data: { state: changed } });
  await prisma.activityAvailability.updateMany({ data: { capacity: 2 } });
  expect((await confirm(draft)).booking.status).toBe('confirmed');
  expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).state).toEqual(changed);
});

test('booking an older draft does not mark a different current proposal as booked', async () => {
  const state = { phase: 'itinerary_proposed', requirements: { participants: 3 } };
  const conversation = await prisma.conversation.create({ data: { userId: fixture.userId, state } });
  const draft = await itinerary({ requirementsSnapshot: { participants: 2 } });
  await prisma.itinerary.update({ where: { id: draft.id }, data: { conversationId: conversation.id } });
  expect((await confirm(draft)).booking.status).toBe('confirmed');
  expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).state).toEqual(state);
});

test('successful modification reserves the new snapshot and updates its conversation', async () => {
  const original = await itinerary();
  const booking = (await confirm(original)).booking;
  const state = { phase: 'itinerary_proposed', requirements: { participants: 1 } };
  const conversation = await prisma.conversation.create({ data: { userId: fixture.userId, state } });
  const replacement = await itinerary({ participants: 1, requirementsSnapshot: state.requirements });
  await prisma.itinerary.update({ where: { id: replacement.id }, data: { conversationId: conversation.id } });
  const modified = await modifyBooking({ userId: fixture.userId, bookingId: booking.id, newItineraryId: replacement.id });
  expect(modified.itineraryId).toBe(replacement.id);
  expect(modified.status).toBe('confirmed');
  expect((await prisma.itinerary.findUnique({ where: { id: original.id } })).status).toBe('cancelled');
  expect((await prisma.conversation.findUnique({ where: { id: conversation.id } })).state.phase).toBe('booking_confirmed');
  await expectInventory(1, 0, 1);
});
