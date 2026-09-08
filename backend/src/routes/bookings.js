import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { cancelBooking, confirmBooking, modifyBooking } from '../services/bookingService.js';

const router = Router();
router.use(requireAuth);

/**
 * Conferma la prenotazione di un itinerario.
 * Richiede idempotencyKey generata lato client (es. uuid v4 per singolo "click" di conferma)
 * per prevenire prenotazioni duplicate in caso di invio ripetuto (retry di rete, doppio click...).
 */
router.post('/', asyncHandler(async (req, res) => {
  const { itineraryId, idempotencyKey, confirm } = req.body;
  if (!itineraryId || !idempotencyKey) {
    return res.status(400).json({ error: 'itineraryId e idempotencyKey sono richiesti' });
  }
  if (confirm !== true) {
    return res.status(400).json({ error: 'Conferma esplicita richiesta (confirm: true)' });
  }

  try {
    const { booking, alreadyProcessed, error } = await confirmBooking({
      userId: req.userId,
      itineraryId,
      idempotencyKey,
    });

    if (error) {
      return res.status(409).json({ error, booking });
    }
    res.status(alreadyProcessed ? 200 : 201).json({ booking, alreadyProcessed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.get('/', asyncHandler(async (req, res) => {
  const bookings = await prisma.booking.findMany({
    where: { userId: req.userId },
    include: { itinerary: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(bookings);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const booking = await cancelBooking({
    userId: req.userId,
    bookingId: req.params.id,
    reason: req.body?.reason,
  });
  res.json({ booking });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const booking = await modifyBooking({
    userId: req.userId,
    bookingId: req.params.id,
    newItineraryId: req.body?.newItineraryId,
  });
  res.json({ booking });
}));

export default router;
