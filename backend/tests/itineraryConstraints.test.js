import { afterEach, jest } from '@jest/globals';

const prisma = {
  flight: { findMany: jest.fn() },
  hotel: { findMany: jest.fn() },
  activityAvailability: { findMany: jest.fn() },
};
const semanticSearch = jest.fn();
jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma }));
jest.unstable_mockModule('../src/services/vectorStore.js', () => ({ semanticSearch }));
const { generateItinerary } = await import('../src/services/itineraryService.js');
const { invalidateSearchCache } = await import('../src/services/searchCache.js');
const { searchCache } = await import('../src/services/searchCache.js');

afterEach(() => searchCache.invalidate());

const date = (day, hour = '00:00:00') => new Date(`2027-07-${String(day).padStart(2, '0')}T${hour}Z`);
const within = (value, range) => (!range.gte || value >= range.gte)
  && (!range.lte || value <= range.lte) && (!range.lt || value < range.lt);
const requirements = {
  budget: 500, country: 'Spagna', departureAirport: 'FCO', activityPreferences: ['cultura'],
  travelMonth: 'luglio', durationDays: 3, participants: 1,
};

describe('itinerary date, location and budget constraints', () => {
  let flights;
  let hotels;
  let slots;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2027-01-01T00:00:00Z'));
    jest.clearAllMocks();
    invalidateSearchCache();
    flights = [
      { id: 'out', direction: 'outbound', date: date(1, '18:00:00'), cost: 50,
        destinationAirportId: 'BCN', destinationAirport: { destinationId: 'barcelona', city: 'Barcelona' } },
      { id: 'back', direction: 'return', date: date(3, '08:00:00'), cost: 50, originAirportId: 'BCN' },
    ];
    hotels = [{ id: 'hotel-bcn', destinationId: 'barcelona', rooms: [
      { date: date(1), roomsAvailable: 1, pricePerNight: 20 },
      { date: date(2), roomsAvailable: 1, pricePerNight: 20 },
    ] }];
    slots = [1, 2].map((day) => ({ activityId: 'museum', destinationId: 'barcelona', date: date(day),
      cost: 5, capacity: 10, booked: 0 }));
    semanticSearch.mockResolvedValue([{ id: 'museum', score: 0.9, metadata: { name: 'Museum', category: 'cultura' } }]);
    // Apply the relevant query constraints to a small multi-city catalogue.
    prisma.flight.findMany.mockImplementation(async ({ where, take }) => {
      const results = flights.filter((flight) => flight.direction === where.direction
        && within(flight.date, where.date)
        && (!where.originAirportId || flight.originAirportId === where.originAirportId));
      return take ? results.slice(0, take) : results;
    });
    prisma.hotel.findMany.mockImplementation(async ({ where }) => hotels.filter((hotel) => hotel.destinationId === where.destinationId));
    prisma.activityAvailability.findMany.mockImplementation(async ({ where }) => slots.filter((slot) =>
      where.activityId.in.includes(slot.activityId) && within(slot.date, where.date)
      && (!where.activity || slot.destinationId === where.activity.destinationId)));
  });

  afterEach(() => jest.useRealTimers());

  test('accepts an early return on the exact UTC date and includes first-day midnight availability', async () => {
    const { primary } = await generateItinerary(requirements);
    expect(primary.flights.inbound.id).toBe('back');
    expect(primary.hotel.nights).toEqual(['2027-07-01', '2027-07-02']);
    expect(primary.activities.map((activity) => activity.date)).toEqual(['2027-07-01', '2027-07-02']);
    expect(primary.totalCost).toBe(150);
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.stringMatching(/cultura/),
      expect.objectContaining({
        country: 'Spagna',
        destinationId: 'barcelona',
        destinationCity: 'Barcelona',
        topK: 20,
      }),
    );
  });

  test('rejects returns on a later day instead of leaving uncovered hotel nights', async () => {
    flights[1].date = date(4);
    const result = await generateItinerary({ ...requirements, durationDays: 2 });
    expect(result.error).toMatch(/nessun ritorno compatibile/);
    expect(prisma.hotel.findMany).not.toHaveBeenCalled();
  });

  test('tries a later outbound when the cheapest has no return on its required date', async () => {
    flights[1].date = date(4);
    flights.push({ ...flights[0], id: 'out-later', date: date(2), cost: 60 });
    hotels[0].rooms.push({ date: date(3), roomsAvailable: 1, pricePerNight: 20 });
    slots.push({ ...slots[0], date: date(3) });
    slots.push({ ...slots[0], activityId: 'madrid-museum', destinationId: 'madrid', date: date(2) });
    slots.push({ ...slots[0], activityId: 'madrid-museum', destinationId: 'madrid', date: date(3) });
    slots.push({ ...slots[0], destinationId: 'madrid', activityId: 'madrid-museum', date: date(2) });
    slots.push({ ...slots[0], destinationId: 'madrid', activityId: 'madrid-museum', date: date(3) });
    const { primary } = await generateItinerary(requirements);
    expect(primary.flights.outbound.id).toBe('out-later');
    expect(primary.hotel.nights).toEqual(['2027-07-02', '2027-07-03']);
  });

  test('tries another flight pair when the first pair has no compatible hotel', async () => {
    hotels[0].rooms.pop();
    hotels.push({ id: 'hotel-madrid', destinationId: 'madrid', rooms: [
      { date: date(2), roomsAvailable: 1, pricePerNight: 20 },
      { date: date(3), roomsAvailable: 1, pricePerNight: 20 },
    ] });
    slots.push({ ...slots[0], date: date(3) });
    flights.push(
      { id: 'out-alt', direction: 'outbound', date: date(2), cost: 60,
        destinationAirportId: 'MAD', destinationAirport: { destinationId: 'madrid', city: 'Madrid' } },
      { id: 'back-alt', direction: 'return', date: date(3, '08:00:00'), cost: 60, originAirportId: 'MAD', destinationAirportId: 'origin' },
    );

    const result = await generateItinerary({ ...requirements, durationDays: 2 });

    expect(result.primary).toBeUndefined();
    expect(result.alternative).toBeUndefined();
  });

  test('keeps return airport, hotel and activities in the outbound destination', async () => {
    flights.splice(1, 0, { ...flights[1], id: 'wrong-return', originAirportId: 'MAD', cost: 1 });
    hotels.unshift({ ...hotels[0], id: 'wrong-hotel', destinationId: 'madrid', rooms: hotels[0].rooms.map((room) => ({ ...room, pricePerNight: 1 })) });
    slots.unshift({ ...slots[0], activityId: 'madrid-museum', destinationId: 'madrid', cost: 1 });
    semanticSearch.mockResolvedValue([
      { id: 'madrid-museum', score: 1, metadata: { name: 'Madrid museum', category: 'cultura' } },
      { id: 'museum', score: 0.9, metadata: { name: 'Barcelona museum', category: 'cultura' } },
    ]);
    const { primary } = await generateItinerary(requirements);
    expect(primary.flights.inbound.id).toBe('back');
    expect(primary.hotel.hotel.id).toBe('hotel-bcn');
    expect(primary.activities.every((activity) => activity.activityId === 'museum')).toBe(true);
  });

  test('keeps a confirmed destination city instead of selecting a cheaper city in the same country', async () => {
    const origin = { id: 'origin', iataCode: 'FCO', city: 'Roma' };
    const destination = {
      id: 'barcelona', country: 'Spagna', countryCode: 'ES', city: 'Barcelona',
      airports: [{ id: 'BCN', iataCode: 'BCN', city: 'Barcelona', name: 'Barcelona' }],
    };
    prisma.airport = { findMany: jest.fn().mockResolvedValue([origin, ...destination.airports]) };
    prisma.destination = { findMany: jest.fn().mockResolvedValue([destination]) };
    flights = [
      { id: 'barcelona-out', direction: 'outbound', date: date(1), cost: 80,
        originAirportId: 'origin', destinationAirportId: 'BCN', destinationAirport: { destinationId: 'barcelona', city: 'Barcelona' } },
      { id: 'barcelona-back', direction: 'return', date: date(3), cost: 80,
        originAirportId: 'BCN', destinationAirportId: 'origin', destinationAirport: { destinationId: null, city: 'Roma' } },
      { id: 'madrid-out', direction: 'outbound', date: date(1), cost: 1,
        originAirportId: 'origin', destinationAirportId: 'MAD', destinationAirport: { destinationId: 'madrid', city: 'Madrid' } },
    ];
    prisma.flight.findMany.mockImplementation(async ({ where, take }) => {
      const results = flights.filter((flight) => flight.direction === where.direction
        && within(flight.date, where.date)
        && (!where.originAirportId || flight.originAirportId === where.originAirportId)
        && (!where.destinationAirportId
          || (where.destinationAirportId.in
            ? where.destinationAirportId.in.includes(flight.destinationAirportId)
            : where.destinationAirportId === flight.destinationAirportId)));
      return take ? results.slice(0, take) : results;
    });

    try {
      const { primary } = await generateItinerary({ ...requirements, destinationCity: 'Barcelona' });
      expect(primary.flights.outbound.id).toBe('barcelona-out');
      expect(primary.flights.inbound.id).toBe('barcelona-back');
      expect(primary.hotel.hotel.id).toBe('hotel-bcn');
    } finally {
      delete prisma.airport;
      delete prisma.destination;
    }
  });

  test('rejects a hotel with one missing night', async () => {
    hotels[0].rooms.pop();
    const result = await generateItinerary(requirements);
    expect(result.error).toMatch(/disponibilità continuativa/);
  });

  test('accepts exact flight and hotel budget and selects free activities', async () => {
    slots.forEach((slot) => { slot.cost = 0; });
    const { primary } = await generateItinerary({ ...requirements, budget: 140 });
    expect(primary.totalCost).toBe(140);
    expect(primary.withinBudget).toBe(true);
    expect(primary.activities).toHaveLength(2);
  });

  test('accepts flights exactly at budget when hotel and activities are free', async () => {
    hotels[0].rooms.forEach((room) => { room.pricePerNight = 0; });
    slots.forEach((slot) => { slot.cost = 0; });
    const { primary } = await generateItinerary({ ...requirements, budget: 100 });
    expect(primary.totalCost).toBe(100);
    expect(primary.withinBudget).toBe(true);
  });

  test('includes a timed departure on the last day of the requested month', async () => {
    flights[0].date = date(31, '23:00:00');
    flights[1].date = new Date('2027-08-02T06:00:00Z');
    hotels[0].rooms[0].date = date(31);
    hotels[0].rooms[1].date = new Date('2027-08-01T00:00:00Z');
    slots = [
      { ...slots[0], date: date(31) },
      { ...slots[0], date: new Date('2027-08-01T00:00:00Z') },
    ];
    const { primary } = await generateItinerary(requirements);
    expect(primary.hotel.nights).toEqual(['2027-07-31', '2027-08-01']);
  });
});
