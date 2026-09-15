import { beforeAll, beforeEach, afterAll, expect, test, jest } from '@jest/globals';

// Match the booking suite guard: never clear an application database.
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
    || database.hostname !== '127.0.0.1'
    || database.pathname !== '/travel_assistant_test'
    || database.username !== 'travel_test') {
  throw new Error('Use node scripts/run-integration-tests.js to provision an isolated test database');
}

const semanticSearch = jest.fn();
jest.unstable_mockModule('../../src/services/vectorStore.js', () => ({ semanticSearch }));
const { prisma } = await import('../../src/db/prisma.js');
const { generateItinerary, monthToDateRange } = await import('../../src/services/itineraryService.js');
const { invalidateSearchCache } = await import('../../src/services/searchCache.js');
const start = monthToDateRange('luglio').start;
const day = (offset, hour = 0) => new Date(Date.UTC(start.getUTCFullYear(), 6, 1 + offset, hour));
const requirements = {
  budget: 500, country: 'Spagna', departureAirport: 'FCO', activityPreferences: ['cultura'],
  travelMonth: 'luglio', durationDays: 3, participants: 1,
};
let fixture;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await prisma.$disconnect(); });

beforeEach(async () => {
  // Il DB effimero viene ricreato tra i test, quindi nessun risultato cache può essere riusato.
  invalidateSearchCache();
  for (const model of ['booking', 'itinerary', 'message', 'conversation', 'user', 'hotelAvailability',
    'activityAvailability', 'flight', 'hotel', 'activity', 'airport', 'destination']) {
    await prisma[model].deleteMany();
  }
  const origin = await prisma.airport.create({ data: {
    iataCode: 'FCO', name: 'Fiumicino', city: 'Roma', countryCode: 'IT',
  } });
  const cities = {};
  // Madrid is intentionally inserted first and offers cheaper, better-ranked services.
  for (const [city, iataCode, price] of [['Madrid', 'MAD', 1], ['Barcelona', 'BCN', 20]]) {
    const destination = await prisma.destination.create({ data: { country: 'Spagna', countryCode: 'ES', city } });
    const airport = await prisma.airport.create({ data: {
      iataCode, name: city, city, countryCode: 'ES', destinationId: destination.id,
    } });
    const hotel = await prisma.hotel.create({ data: {
      name: `Hotel ${city}`, destinationId: destination.id, country: 'Spagna', city,
    } });
    const activity = await prisma.activity.create({ data: {
      name: `Museum ${city}`, destinationId: destination.id, country: 'Spagna', city, category: 'cultura',
    } });
    for (const offset of [0, 1]) {
      await prisma.hotelAvailability.create({ data: {
        hotelId: hotel.id, date: day(offset), pricePerNight: price, roomsAvailable: 1,
      } });
      await prisma.activityAvailability.create({ data: {
        activityId: activity.id, date: day(offset), cost: 5, capacity: 10,
      } });
    }
    const inbound = await prisma.flight.create({ data: {
      originAirportId: airport.id, destinationAirportId: origin.id, direction: 'return',
      date: day(2, 8), seatsAvailable: 10, cost: city === 'Madrid' ? 1 : 50,
    } });
    cities[city] = { destination, airport, hotel, activity, inbound };
  }
  const outbound = await prisma.flight.create({ data: {
    originAirportId: origin.id, destinationAirportId: cities.Barcelona.airport.id,
    direction: 'outbound', date: day(0, 18), seatsAvailable: 10, cost: 50,
  } });
  const madridOutbound = await prisma.flight.create({ data: {
    originAirportId: origin.id, destinationAirportId: cities.Madrid.airport.id,
    direction: 'outbound', date: day(0, 18), seatsAvailable: 10, cost: 60,
  } });
  // A later return remains available when the exact-date option is removed.
  await prisma.flight.create({ data: {
    originAirportId: cities.Barcelona.airport.id, destinationAirportId: origin.id,
    direction: 'return', date: day(3, 8), seatsAvailable: 10, cost: 10,
  } });
  semanticSearch.mockResolvedValue(Object.values(cities).map(({ activity }, index) => ({
    id: activity.id, score: index === 0 ? 1 : 0.9,
    metadata: { name: activity.name, category: activity.category, country: 'Spagna', city: activity.city },
  })));
  fixture = { ...cities.Barcelona, outbound, madridOutbound, madrid: cities.Madrid };
});

test('presenta una coppia di voli alternativa quando la prima destinazione non ha hotel', async () => {
  // La coppia Barcelona e la piu economica, ma il soggiorno non e vendibile:
  // il solver deve quindi esplorare Madrid senza ripetere la ricerca di Barcelona.
  await prisma.hotelAvailability.deleteMany({ where: { hotelId: fixture.hotel.id } });

  const result = await generateItinerary(requirements);

  expect(result.primary).toBeNull();
  expect(result.alternative).toEqual(expect.objectContaining({
    withinBudget: true,
    totalCost: 73,
    compromises: expect.arrayContaining([
      'Selezionata una coppia di voli alternativa con hotel compatibile.',
    ]),
  }));
  expect(result.alternative.flights.outbound.id).toBe(fixture.madridOutbound.id);
  expect(result.alternative.flights.inbound.id).toBe(fixture.madrid.inbound.id);
  expect(result.alternative.hotel.hotel.id).toBe(fixture.madrid.hotel.id);
});

test('real relational filters keep flights, all nights and activities in the arrival city', async () => {
  const { primary } = await generateItinerary(requirements);
  expect(primary.flights.outbound.id).toBe(fixture.outbound.id);
  expect(primary.flights.inbound.id).toBe(fixture.inbound.id);
  expect(primary.flights.inbound.date).toEqual(day(2, 8));
  expect(primary.hotel.hotel.id).toBe(fixture.hotel.id);
  expect(primary.hotel.nights).toEqual([day(0), day(1)].map(date => date.toISOString().slice(0, 10)));
  expect(primary.activities).toHaveLength(2);
  expect(primary.activities.map(activity => activity.activityId)).toEqual([fixture.activity.id, fixture.activity.id]);
  expect(primary.activities.map(activity => activity.date)).toEqual(primary.hotel.nights);
  expect(primary.totalCost).toBe(150);
});

test('distingue aeroporto non riconosciuto, destinazione non catalogata e mese senza voli', async () => {
  const unknownAirport = await generateItinerary({ ...requirements, departureAirport: 'XXX' });
  expect(unknownAirport.errorCode).toBe('unknown_origin_airport');
  expect(unknownAirport.error).toMatch(/non è riconosciuto/);

  const unknownDestination = await generateItinerary({ ...requirements, country: 'Atlantide' });
  expect(unknownDestination.errorCode).toBe('unknown_destination');
  expect(unknownDestination.error).toMatch(/non è presente nel catalogo/);

  const uncoveredMonth = await generateItinerary({ ...requirements, travelMonth: 'gennaio' });
  expect(uncoveredMonth.errorCode).toBe('no_outbound');
  expect(uncoveredMonth.error).toMatch(/Nessun volo/);
  expect(uncoveredMonth.error).toMatch(/Mesi disponibili nel catalogo: luglio/);
  expect(uncoveredMonth.alternatives.map(({ city }) => city)).toEqual(
    expect.arrayContaining(['Madrid', 'Barcelona']),
  );
});

test('il codice ISO mantiene la ricerca nazionale, mentre la cittÃ  seleziona il catalogo coerente', async () => {
  const isoResult = await generateItinerary({ ...requirements, country: 'ES' });
  expect(isoResult.primary.flights.outbound.id).toBe(fixture.outbound.id);

  const cityResult = await generateItinerary({ ...requirements, country: 'Madrid' });
  expect(cityResult.primary.flights.outbound.id).toBe(fixture.madridOutbound.id);
  expect(cityResult.primary.hotel.hotel.id).toBe(fixture.madrid.hotel.id);
  expect(cityResult.primary.activities.every((activity) => activity.activityId === fixture.madrid.activity.id)).toBe(true);
});

test('rejects later returns and returns from another city when the exact match is absent', async () => {
  await prisma.flight.delete({ where: { id: fixture.inbound.id } });
  await prisma.flight.delete({ where: { id: fixture.madridOutbound.id } });
  await prisma.flight.create({ data: {
    originAirportId: fixture.airport.id, destinationAirportId: fixture.outbound.originAirportId,
    direction: 'return', date: day(3, 8), seatsAvailable: 10, cost: 12,
  } });
  const result = await generateItinerary(requirements);
  expect(result.error).toMatch(/nessun ritorno compatibile/);
  expect(result.error).toMatch(/il \d{4}-\d{2}-\d{2}/);
  expect(result.error).toMatch(/ritorno atteso il \d{4}-\d{2}-\d{2}/);
  expect(result.outbound).toMatchObject({
    origin: { iataCode: 'FCO' },
    destination: { iataCode: 'BCN' },
  });
  expect(result.error).toMatch(/Ritorni disponibili dal catalogo/);
  expect(result.requested).toEqual(expect.objectContaining({
    date: fixture.outbound.date.toISOString(), durationDays: 3,
    expectedReturnDate: day(2).toISOString(),
  }));
  expect(result.availableReturns).toHaveLength(1);
  expect(result.availableReturns[0]).toEqual(expect.objectContaining({
    availableReturnDate: day(3, 8).toISOString(), daysShift: 1, resultingDurationDays: 3,
  }));
  expect(result.alternatives).toEqual(result.availableReturns);
  expect(result.primary).toBeUndefined();
});

test('rejects a missing hotel night despite full availability in another city', async () => {
  await prisma.hotelAvailability.deleteMany({ where: { hotelId: fixture.hotel.id, date: day(1) } });
  await prisma.flight.delete({ where: { id: fixture.madridOutbound.id } });
  const result = await generateItinerary(requirements);
  expect(result.error).toMatch(/disponibilità continuativa/);
  expect(result.primary).toBeUndefined();
});
