import { prisma } from '../db/prisma.js';
import { invalidateSearchCache } from './searchCache.js';

export class BookingLifecycleError extends Error {
  constructor(message, status = 409, code) {
    super(message);
    this.name = 'BookingLifecycleError';
    this.status = status;
    this.code = code;
  }
}

function itineraryDateRange(details) {
  const values = [
    details?.flights?.outbound?.date,
    details?.flights?.inbound?.date,
    ...(details?.hotel?.nights || []),
    ...(details?.activities || []).map((activity) => activity?.date),
  ].filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime()));
  if (values.length === 0) return null;
  return {
    start: new Date(Math.min(...values.map((value) => value.getTime()))),
    end: new Date(Math.max(...values.map((value) => value.getTime()))),
  };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

export async function findConfirmedDateConflict(client, { userId, details, excludedBookingId, excludedItineraryId } = {}) {
  const candidate = itineraryDateRange(details);
  if (!candidate) return null;
  const bookings = await client.booking.findMany({
    where: {
      userId,
      status: 'confirmed',
      ...(excludedItineraryId ? { itineraryId: { not: excludedItineraryId } } : {}),
      ...(excludedBookingId ? { id: { not: excludedBookingId } } : {}),
    },
    include: { itinerary: { select: { details: true } } },
  });
  const conflict = bookings.find((booking) => {
    const existing = itineraryDateRange(booking.itinerary?.details);
    return existing && rangesOverlap(candidate, existing);
  });
  if (!conflict) return null;
  return { booking: conflict, candidate, existing: itineraryDateRange(conflict.itinerary?.details) };
}

async function assertNoDateConflict(client, itinerary, excludedBookingId) {
  const conflict = await findConfirmedDateConflict(client, {
    userId: itinerary.userId,
    details: itinerary.details,
    excludedBookingId,
    excludedItineraryId: itinerary.id,
  });
  if (conflict) throw new BookingLifecycleError(
    'Le date dell’itinerario si sovrappongono a una prenotazione già confermata.',
    409,
    'ITINERARY_DATE_CONFLICT',
  );
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
    const affected = activity.availabilityId
      ? await tx.$executeRaw`
        UPDATE "ActivityAvailability"
        SET booked = booked + ${details.participants}
        WHERE id = ${activity.availabilityId}
          AND booked + ${details.participants} <= capacity
      `
      : await tx.$executeRaw`
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
    const affected = activity.availabilityId
      ? await tx.$executeRaw`
        UPDATE "ActivityAvailability"
        SET booked = booked - ${details.participants}
        WHERE id = ${activity.availabilityId}
          AND booked >= ${details.participants}
      `
      : await tx.$executeRaw`
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
function replayBooking(existing, userId, itineraryId) {
  if (existing.userId !== userId || existing.itineraryId !== itineraryId) {
    throw new BookingLifecycleError('Chiave di idempotenza già utilizzata per un’altra richiesta');
  }
  return {
    booking: existing, alreadyProcessed: true,
    ...(existing.status === 'failed' ? { error: existing.failureReason } : {}),
  };
}

const BOOKING_OVERLAP_LOCK = 748291;

async function lockBookingOverlap(tx) {
  // Un solo lock transazionale serializza il check business sulle date anche
  // quando le prenotazioni usano risorse di catalogo completamente diverse.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOKING_OVERLAP_LOCK})`;
}

function priceChanged(expected, actual) {
  return expected !== undefined && expected !== null && Number(expected) !== Number(actual);
}

async function assertCurrentPrices(tx, itinerary) {
  const details = bookingResourceDetails(itinerary);
  const flightIds = [details.flights.outbound.id, details.flights.inbound.id];
  const flights = await tx.flight.findMany({ where: { id: { in: flightIds } }, select: { id: true, cost: true } });
  const byFlight = new Map(flights.map((flight) => [flight.id, flight]));
  for (const flight of [details.flights.outbound, details.flights.inbound]) {
    const current = byFlight.get(flight.id);
    if (!current || priceChanged(flight.cost, current.cost)) {
      throw new BookingLifecycleError('Il prezzo del volo è cambiato, aggiorna l’itinerario', 409, 'PRICE_CHANGED');
    }
  }

  for (const night of details.hotel.nights) {
    const current = await tx.hotelAvailability.findUnique({
      where: { hotelId_date: { hotelId: details.hotel.id, date: new Date(night) } },
      select: { pricePerNight: true },
    });
    const expected = details.hotel.prices?.[night] ?? details.hotel.pricePerNight;
    if (!current || priceChanged(expected, current.pricePerNight)) {
      throw new BookingLifecycleError('Il prezzo dell’hotel è cambiato, aggiorna l’itinerario', 409, 'PRICE_CHANGED');
    }
  }

  for (const activity of details.activities) {
    const current = activity.availabilityId
      ? await tx.activityAvailability.findUnique({ where: { id: activity.availabilityId }, select: { cost: true } })
      : await tx.activityAvailability.findFirst({ where: { activityId: activity.activityId, date: new Date(activity.date) }, select: { cost: true } });
    // Lo snapshot espone il costo totale della voce (costo unitario × partecipanti),
    // mentre ActivityAvailability conserva il costo unitario. Confrontare i valori
    // grezzi genera un falso PRICE_CHANGED per ogni gruppo di almeno due persone.
    const expectedUnitCost = Number.isFinite(Number(activity.cost)) && details.participants > 0
      ? Number(activity.cost) / details.participants
      : activity.cost;
    if (!current || priceChanged(expectedUnitCost, current.cost)) {
      throw new BookingLifecycleError('Il prezzo dell’attività è cambiato, aggiorna l’itinerario', 409, 'PRICE_CHANGED');
    }
  }
}

async function markConversationBooked(tx, itinerary) {
  if (!itinerary.conversationId) return;
  const snapshot = itinerary.details?.requirementsSnapshot;
  // Update only the phase, preserving concurrent changes to the JSON state.
  await tx.$executeRaw`
    UPDATE "Conversation"
    SET state = jsonb_set(state, '{phase}', '"booking_confirmed"'::jsonb),
        "updatedAt" = NOW()
    WHERE id = ${itinerary.conversationId}
      AND "userId" = ${itinerary.userId}
      AND state->>'phase' = 'itinerary_proposed'
      AND (${snapshot === undefined} OR state->'requirements' = ${JSON.stringify(snapshot ?? null)}::jsonb)
  `;
}

export async function confirmBooking({ userId, itineraryId, idempotencyKey }) {
  const existing = await prisma.booking.findUnique({ where: { idempotencyKey } });
  if (existing) {
    return replayBooking(existing, userId, itineraryId);
  }

  const itinerary = await prisma.itinerary.findUnique({ where: { id: itineraryId } });
  if (!itinerary || itinerary.userId !== userId) {
    throw new BookingLifecycleError('Itinerario non trovato', 404);
  }
  if (itinerary.status !== 'draft') {
    const completed = await prisma.booking.findUnique({ where: { idempotencyKey } });
    if (completed) return replayBooking(completed, userId, itineraryId);
    throw new BookingLifecycleError(itinerary.status === 'confirmed'
      ? 'Itinerario già prenotato' : 'Il nuovo itinerario deve essere in stato draft');
  }

  // Fast-fail non transazionale; il controllo viene ripetuto sotto advisory
  // lock nella transazione per chiudere la race tra lettura e conferma.
  await assertNoDateConflict(prisma, itinerary);

  try {
    const booking = await prisma.$transaction(async (tx) => {
      await lockBookingOverlap(tx);
      await assertNoDateConflict(tx, itinerary);
      await assertCurrentPrices(tx, itinerary);
      const claimed = await tx.itinerary.updateMany({
        where: { id: itineraryId, userId, status: 'draft' },
        data: { status: 'confirmed' },
      });
      if (claimed.count !== 1) throw new BookingLifecycleError('Itinerario già prenotato');
      await reserveResources(tx, itinerary);
      await markConversationBooked(tx, itinerary);

      return tx.booking.create({
        data: {
          userId,
          itineraryId,
          status: 'confirmed',
          idempotencyKey,
        },
      });
    });

    invalidateSearchCache();
    return { booking, alreadyProcessed: false };
  } catch (err) {
    // Rollback automatico della transazione: nessuna risorsa risulta scalata a metà.
    // Registriamo comunque un booking "failed" per tracciabilità (fuori dalla transazione fallita).
    const winner = await prisma.booking.findUnique({ where: { idempotencyKey } });
    if (winner) return replayBooking(winner, userId, itineraryId);
    if (err.code === 'ITINERARY_DATE_CONFLICT') throw err;
    let failedBooking;
    try {
      failedBooking = await prisma.booking.create({
        data: {
          userId,
          itineraryId,
          status: 'failed',
          idempotencyKey,
          failureReason: err.message,
        },
      });
    } catch (writeError) {
      if (writeError.code !== 'P2002') throw writeError;
      const concurrent = await prisma.booking.findUnique({ where: { idempotencyKey } });
      if (!concurrent) throw writeError;
      return replayBooking(concurrent, userId, itineraryId);
    }
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

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, userId, status: 'confirmed', itineraryId: booking.itineraryId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: reason,
        },
      });
      if (updated.count !== 1) {
        throw new BookingLifecycleError('La prenotazione è stata modificata da un\'altra operazione');
      }
      await releaseResources(tx, booking.itinerary);
      await tx.itinerary.update({
        where: { id: booking.itineraryId },
        data: { status: 'cancelled' },
      });
      return tx.booking.findUnique({ where: { id: bookingId }, include: { itinerary: true } });
    });
    invalidateSearchCache();
    return result;
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

    await assertNoDateConflict(prisma, newItinerary, bookingId);

    const result = await prisma.$transaction(async (tx) => {
      await lockBookingOverlap(tx);
      await assertNoDateConflict(tx, newItinerary, bookingId);
      await assertCurrentPrices(tx, newItinerary);
      // Il confronto dello snapshot serializza modifica/cancellazione concorrenti.
      const claimed = await tx.booking.updateMany({
        where: { id: bookingId, userId, status: 'confirmed', itineraryId: booking.itineraryId },
        data: { itineraryId: newItineraryId },
      });
      if (claimed.count !== 1) {
        throw new BookingLifecycleError('La prenotazione è stata modificata da un’altra operazione');
      }
      const target = await tx.itinerary.updateMany({
        where: { id: newItineraryId, userId, status: 'draft' },
        data: { status: 'confirmed' },
      });
      if (target.count !== 1) throw new BookingLifecycleError('Il nuovo itinerario deve essere in stato draft');
      // Si libera prima il vecchio snapshot: in caso di errore il DB fa rollback completo.
      await releaseResources(tx, booking.itinerary);
      await reserveResources(tx, newItinerary);
      await markConversationBooked(tx, newItinerary);
      await tx.itinerary.update({ where: { id: booking.itineraryId }, data: { status: 'cancelled' } });
      return tx.booking.update({
        where: { id: bookingId },
        data: { itineraryId: newItineraryId },
        include: { itinerary: true },
      });
    });
    invalidateSearchCache();
    return result;
}
