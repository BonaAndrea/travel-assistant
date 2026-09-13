import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { cancelBooking, confirmBooking, modifyBooking } from '../services/bookingService.js';
import { metrics, metricErrorCategory } from '../services/metrics.js';
import { bookingCancelSchema, bookingCreateSchema, bookingModifySchema, validationError } from '../validation.js';

const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  res.on('finish', () => {
    const operation = req.method === 'POST' ? 'confirm'
      : req.method === 'PATCH' ? 'modify'
        : req.method === 'DELETE' ? 'cancel' : 'list';
    metrics.increment('booking_operations_total', {
      operation,
      outcome: res.statusCode >= 200 && res.statusCode < 400 ? 'success' : 'failed',
    });
  });
  next();
});

/**
 * Conferma la prenotazione di un itinerario.
 * Richiede idempotencyKey generata lato client (es. uuid v4 per singolo "click" di conferma)
 * per prevenire prenotazioni duplicate in caso di invio ripetuto (retry di rete, doppio click...).
 */
router.post('/', asyncHandler(async (req, res) => {
  const parsed = bookingCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationError('Dati prenotazione non validi', parsed.error));
  const { itineraryId, idempotencyKey } = parsed.data;

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
    metrics.increment('booking_failures_total', { operation: 'confirm', error: metricErrorCategory(err) });
    res.status(err.status || 400).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
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
  const parsed = bookingCancelSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json(validationError('Dati cancellazione non validi', parsed.error));
  const booking = await cancelBooking({
    userId: req.userId,
    bookingId: req.params.id,
    reason: parsed.data.reason,
  });
  res.json({ booking });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const parsed = bookingModifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationError('Dati modifica non validi', parsed.error));
  const booking = await modifyBooking({
    userId: req.userId,
    bookingId: req.params.id,
    newItineraryId: parsed.data.newItineraryId,
  });
  res.json({ booking });
}));

export default router;
