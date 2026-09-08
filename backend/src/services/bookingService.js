import { prisma } from '../db/prisma.js';

export class BookingLifecycleError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'BookingLifecycleError';
    this.status = status;
  }
}

function bookingResourceDetails(itinerary) {
  const details = itinerary?.details;
  if (!details?.flights?.outbound?.id || !details?.flights?.inbound?.id
    || !details?.hotel?.id || !Array.isArray(details.hotel.nights)
    || !Array.isArray(details.activities) || !Number.isInteger(details.participants)
    || details.participants < 1) {
    throw new BookingLifecycleError('Snapshot itinerario non valido', 400);
  }
  return details;
}

async function reserveResources(tx, itinerary) {
  const details = bookingResourceDetails(itinerary);

  for (const flightId of [details.flights.outbound.id, details.flights.inbound.id]) {
    const updated = await tx.flight.updateMany({
      where: { id: flightId, seatsAvailable: { gte: details.participants } },
      data: { seatsAvailable: { decrement: details.participants } },
    });
    if (updated.count === 0) {
      throw new BookingLifecycleError('Posti volo non più disponibili al momento della conferma');
    }
  }

  for (const nightDate of details.hotel.nights) {
    const updated = await tx.hotelAvailability.updateMany({
      where: {
        hotelId: details.hotel.id,
        date: new Date(nightDate),
        roomsAvailable: { gte: 1 },
      },
      data: { roomsAvailable: { decrement: 1 } },
    });
    if (updated.count === 0) {
      throw new BookingLifecycleError(`Camera non più disponibile per la notte del ${nightDate}`);
    }
  }

  for (const activity of details.activities) {
    const affected = await tx.$executeRaw`
      UPDATE "ActivityAvailability"
      SET booked = booked + ${details.participants}
      WHERE "activityId" = ${activity.activityId}
        AND date = ${new Date(activity.date)}
        AND booked + ${details.participants} <= capacity
    `;
    if (affected === 0) {
      throw new BookingLifecycleError(`Capacità non più disponibile per l'attività "${activity.name}"`);
    }
  }
}

async function releaseResources(tx, itinerary) {
  const details = bookingResourceDetails(itinerary);

  for (const flightId of [details.flights.outbound.id, details.flights.inbound.id]) {
    await tx.flight.update({
      where: { id: flightId },
      data: { seatsAvailable: { increment: details.participants } },
    });
  }

  for (const nightDate of details.hotel.nights) {
    await tx.hotelAvailability.update({
      where: { hotelId_date: { hotelId: details.hotel.id, date: new Date(nightDate) } },
      data: { roomsAvailable: { increment: 1 } },
    });
  }

  for (const activity of details.activities) {
    const affected = await tx.$executeRaw`
      UPDATE "ActivityAvailability"
      SET booked = booked - ${details.participants}
      WHERE "activityId" = ${activity.activityId}
        AND date = ${new Date(activity.date)}
        AND booked >= ${details.participants}
    `;
    if (affected === 0) {
      throw new BookingLifecycleError(`Disponibilità attività non coerente per "${activity.name}"`, 500);
    }
  }
}

/**
 * Conferma una prenotazione per un itinerario "draft".
 *
 * Garanzie:
 * - Idempotenza: idempotencyKey univoca -> un invio ripetuto della stessa richiesta
 *   ritorna la prenotazione già creata invece di crearne una nuova.
 * - Concorrenza: la decrementazione di posti/camere/capacità avviene con update condizionali
 *   (WHERE ...Available >= richiesto) dentro un'unica transazione DB. Se anche un solo
 *   componente non è più disponibile, l'intera transazione viene annullata (rollback):
 *   l'utente non vede mai un itinerario "confermato" ma parzialmente prenotato.
 */
export async function confirmBooking({ userId, itineraryId, idempotencyKey }) {
  const existing = await prisma.booking.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return { booking: existing, alreadyProcessed: true };
  }

  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary || itinerary.userId !== userId) {
    throw new Error('Itinerario non trovato');
  }
  if (itinerary.status === 'confirmed') {
    throw new Error('Itinerario già prenotato');
  }

  const details = itinerary.details;

  try {
    const booking = await prisma.$transaction(async (tx) => {
      await reserveResources(tx, itinerary);
      await tx.itinerary.update({ where: { id: itineraryId }, data: { status: 'confirmed' } });

      return tx.booking.create({
        data: {
          userId,
          itineraryId,
          status: 'confirmed',
          idempotencyKey,
        },
      });
    });

    return { booking, alreadyProcessed: false };
  } catch (err) {
    // Rollback automatico della transazione: nessuna risorsa risulta scalata a metà.
    // Registriamo comunque un booking "failed" per tracciabilità (fuori dalla transazione fallita).
    const failedBooking = await prisma.booking.create({
      data: {
        userId,
        itineraryId,
        status: 'failed',
        idempotencyKey: `${idempotencyKey}-failed-${Date.now()}`,
        failureReason: err.message,
      },
    });
    return { booking: failedBooking, alreadyProcessed: false, error: err.message };
  }
}

export async function cancelBooking({ userId, bookingId, reason = 'Cancellata dall\'utente' }) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { itinerary: true },
    });
    if (!booking || booking.userId !== userId) {
      throw new BookingLifecycleError('Prenotazione non trovata', 404);
    }
    if (booking.status !== 'confirmed') {
      throw new BookingLifecycleError('È possibile cancellare solo una prenotazione confermata');
    }

    return prisma.$transaction(async (tx) => {
      await releaseResources(tx, booking.itinerary);
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, userId, status: 'confirmed' },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
      });
      if (updated.count !== 1) {
        throw new BookingLifecycleError('La prenotazione è stata modificata da un\'altra operazione');
      }
      await tx.itinerary.update({
        where: { id: booking.itineraryId },
        data: { status: 'cancelled' },
      });
      return tx.booking.findUnique({ where: { id: bookingId }, include: { itinerary: true } });
    });
  }

export async function modifyBooking({ userId, bookingId, newItineraryId }) {
    if (!newItineraryId) throw new BookingLifecycleError('newItineraryId è richiesto', 400);

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { itinerary: true },
    });
    if (!booking || booking.userId !== userId) {
      throw new BookingLifecycleError('Prenotazione non trovata', 404);
    }
    if (booking.status !== 'confirmed') {
      throw new BookingLifecycleError('È possibile modificare solo una prenotazione confermata');
    }
    if (booking.itineraryId === newItineraryId) {
      throw new BookingLifecycleError('Il nuovo itinerario deve essere diverso da quello attuale', 400);
    }

    const newItinerary = await prisma.itinerary.findUnique({ where: { id: newItineraryId } });
    if (!newItinerary || newItinerary.userId !== userId) {
      throw new BookingLifecycleError('Nuovo itinerario non trovato', 404);
    }
    if (newItinerary.status !== 'draft') {
      throw new BookingLifecycleError('Il nuovo itinerario deve essere in stato draft');
    }

    return prisma.$transaction(async (tx) => {
      // Si libera prima il vecchio snapshot: in caso di errore il DB fa rollback completo.
      await releaseResources(tx, booking.itinerary);
      await reserveResources(tx, newItinerary);
      await tx.itinerary.update({ where: { id: booking.itineraryId }, data: { status: 'cancelled' } });
      await tx.itinerary.update({ where: { id: newItineraryId }, data: { status: 'confirmed' } });
      return tx.booking.update({
        where: { id: bookingId },
        data: { itineraryId: newItineraryId },
        include: { itinerary: true },
      });
    });
}
