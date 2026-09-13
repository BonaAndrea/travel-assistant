import { jest } from '@jest/globals';

const mockPrisma = {
  booking: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  itinerary: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: mockPrisma,
}));

const { confirmBooking } = await import('../src/services/bookingService.js');

describe('confirmBooking business logic', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([]);
  });

  test('rifiuta una nuova prenotazione con date sovrapposte', async () => {
    const dateRange = {
      flights: { outbound: { id: 'f1', date: '2030-06-10' }, inbound: { id: 'f2', date: '2030-06-12' } },
      hotel: { id: 'h1', nights: ['2030-06-10'] }, activities: [], participants: 1,
    };
    mockPrisma.itinerary.findUnique.mockResolvedValue({ id: 'itin-2', userId: 'user-1', status: 'draft', details: dateRange });
    mockPrisma.booking.findMany.mockResolvedValue([{ itinerary: { details: {
      flights: { outbound: { date: '2030-06-11' }, inbound: { date: '2030-06-13' } },
      hotel: { nights: ['2030-06-11'] }, activities: [],
    } } }]);

    await expect(confirmBooking({ userId: 'user-1', itineraryId: 'itin-2', idempotencyKey: 'key-overlap' }))
      .rejects.toMatchObject({ code: 'ITINERARY_DATE_CONFLICT', status: 409 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  test('se esiste già una prenotazione con la stessa idempotencyKey, la ritorna immediatamente', async () => {
    const existing = { id: 'booking-1', userId: 'user-1', itineraryId: 'itin-1', status: 'confirmed', idempotencyKey: 'key-123' };
    mockPrisma.booking.findUnique.mockResolvedValueOnce(existing);

    const result = await confirmBooking({
      userId: 'user-1',
      itineraryId: 'itin-1',
      idempotencyKey: 'key-123',
    });

    expect(result).toEqual({ booking: existing, alreadyProcessed: true });
    expect(mockPrisma.itinerary.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('rifiuta il riuso della chiave da un altro utente o per un altro itinerario', async () => {
    mockPrisma.booking.findUnique.mockResolvedValue({ userId: 'other-user', itineraryId: 'itin-1' });
    await expect(confirmBooking({ userId: 'user-1', itineraryId: 'itin-1', idempotencyKey: 'key' }))
      .rejects.toThrow('Chiave di idempotenza');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    mockPrisma.booking.findUnique.mockReset();
  });

  test('ripete anche un fallimento senza creare un secondo booking', async () => {
    const booking = { userId: 'user-1', itineraryId: 'itin-1', status: 'failed', failureReason: 'Esaurito' };
    mockPrisma.booking.findUnique.mockResolvedValueOnce(booking);
    await expect(confirmBooking({ userId: 'user-1', itineraryId: 'itin-1', idempotencyKey: 'key' }))
      .resolves.toEqual({ booking, alreadyProcessed: true, error: 'Esaurito' });
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  test('una conferma concorrente dello stesso draft non scala nuovamente risorse', async () => {
    const winner = { id: 'booking-1', userId: 'user-1', itineraryId: 'itin-1', status: 'confirmed' };
    mockPrisma.booking.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    mockPrisma.itinerary.findUnique.mockResolvedValueOnce({ id: 'itin-1', userId: 'user-1', status: 'draft' });
    const tx = {
      itinerary: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      flight: { updateMany: jest.fn() },
    };
    mockPrisma.$transaction.mockImplementationOnce((callback) => callback(tx));
    await expect(confirmBooking({ userId: 'user-1', itineraryId: 'itin-1', idempotencyKey: 'key' }))
      .resolves.toEqual({ booking: winner, alreadyProcessed: true });
    expect(tx.flight.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  test('cancellazione su snapshot superato non libera risorse', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: 'booking-1', userId: 'user-1', itineraryId: 'itin-1', status: 'confirmed', itinerary: {},
    });
    const tx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      flight: { update: jest.fn() },
    };
    mockPrisma.$transaction.mockImplementationOnce((callback) => callback(tx));
    const { cancelBooking } = await import('../src/services/bookingService.js');
    await expect(cancelBooking({ userId: 'user-1', bookingId: 'booking-1' }))
      .rejects.toThrow('modificata');
    expect(tx.flight.update).not.toHaveBeenCalled();
  });

  test('se itinerario non esiste o appartiene ad altro utente, lancia errore', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
    mockPrisma.itinerary.findUnique.mockResolvedValueOnce(null);

    await expect(
      confirmBooking({
        userId: 'user-1',
        itineraryId: 'itin-not-found',
        idempotencyKey: 'key-abc',
      })
    ).rejects.toThrow('Itinerario non trovato');
  });

  test('se itinerario appartiene ad un altro utente, lancia errore', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
    mockPrisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 'itin-1',
      userId: 'other-user',
      status: 'draft',
    });

    await expect(
      confirmBooking({
        userId: 'user-1',
        itineraryId: 'itin-1',
        idempotencyKey: 'key-abc',
      })
    ).rejects.toThrow('Itinerario non trovato');
  });

  test('se itinerario è già in stato confirmed, lancia errore', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
    mockPrisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 'itin-1',
      userId: 'user-1',
      status: 'confirmed',
    });

    await expect(
      confirmBooking({
        userId: 'user-1',
        itineraryId: 'itin-1',
        idempotencyKey: 'key-abc',
      })
    ).rejects.toThrow('Itinerario già prenotato');
  });

  test('se la transazione fallisce (es. posti esauriti), crea booking con stato failed', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
    mockPrisma.itinerary.findUnique.mockResolvedValueOnce({
      id: 'itin-1',
      userId: 'user-1',
      status: 'draft',
      details: {
        flights: { outbound: { id: 'f1' }, inbound: { id: 'f2' } },
        hotel: { id: 'h1', nights: ['2026-11-01'] },
        activities: [],
        participants: 2,
      },
    });

    mockPrisma.$transaction.mockRejectedValueOnce(new Error('Posti volo non più disponibili'));
    const failedBookingMock = {
      id: 'booking-failed-1',
      status: 'failed',
      failureReason: 'Posti volo non più disponibili',
    };
    mockPrisma.booking.create.mockResolvedValueOnce(failedBookingMock);

    const result = await confirmBooking({
      userId: 'user-1',
      itineraryId: 'itin-1',
      idempotencyKey: 'key-fail-test',
    });

    expect(result.alreadyProcessed).toBe(false);
    expect(result.error).toBe('Posti volo non più disponibili');
    expect(result.booking.status).toBe('failed');
    expect(mockPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          itineraryId: 'itin-1',
          status: 'failed',
          failureReason: 'Posti volo non più disponibili',
        }),
      })
    );
  });

  test('cancellazione proprietario ripristina tutte le risorse nella stessa transazione', async () => {
    const booking = {
      id: 'booking-1',
      userId: 'user-1',
      itineraryId: 'itin-1',
      status: 'confirmed',
      itinerary: {
        id: 'itin-1',
        details: {
          flights: { outbound: { id: 'f1' }, inbound: { id: 'f2' } },
          hotel: { id: 'h1', nights: ['2026-11-01'] },
          activities: [{ activityId: 'a1', date: '2026-11-01', name: 'Museo' }],
          participants: 2,
        },
      },
    };
    const tx = {
      flight: { update: jest.fn().mockResolvedValue({}) },
      hotelAvailability: { update: jest.fn().mockResolvedValue({}) },
      booking: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ ...booking, status: 'cancelled' }),
      },
      itinerary: { update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    mockPrisma.booking.findUnique.mockResolvedValueOnce(booking);
    mockPrisma.$transaction.mockImplementationOnce((callback) => callback(tx));

    const result = await (await import('../src/services/bookingService.js')).cancelBooking({
      userId: 'user-1',
      bookingId: 'booking-1',
      reason: 'Cambio programma',
    });

    expect(result.status).toBe('cancelled');
    expect(tx.flight.update).toHaveBeenCalledTimes(2);
    expect(tx.hotelAvailability.update).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'booking-1', userId: 'user-1', status: 'confirmed', itineraryId: 'itin-1' },
      data: expect.objectContaining({ status: 'cancelled', cancellationReason: 'Cambio programma' }),
    }));
  });

  test('modifica rifiuta un nuovo itinerario non draft', async () => {
    mockPrisma.booking.findUnique.mockResolvedValueOnce({
      id: 'booking-1',
      userId: 'user-1',
      itineraryId: 'itin-1',
      status: 'confirmed',
      itinerary: { id: 'itin-1', details: {} },
    });
    mockPrisma.itinerary = { findUnique: jest.fn().mockResolvedValueOnce({
      id: 'itin-2',
      userId: 'user-1',
      status: 'confirmed',
    }) };

    const { modifyBooking } = await import('../src/services/bookingService.js');
    await expect(modifyBooking({
      userId: 'user-1',
      bookingId: 'booking-1',
      newItineraryId: 'itin-2',
    })).rejects.toThrow('deve essere in stato draft');
  });
});
