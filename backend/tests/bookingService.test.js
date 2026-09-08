import { jest } from '@jest/globals';

const mockPrisma = {
  booking: {
    findUnique: jest.fn(),
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
    jest.clearAllMocks();
  });

  test('se esiste già una prenotazione con la stessa idempotencyKey, la ritorna immediatamente', async () => {
    const existing = { id: 'booking-1', status: 'confirmed', idempotencyKey: 'key-123' };
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
      where: { id: 'booking-1', userId: 'user-1', status: 'confirmed' },
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
