import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * Salva come "draft" l'opzione (primary|alternative) proposta in una conversazione,
 * così da poterla referenziare in fase di prenotazione con un id stabile.
 */
router.post('/', asyncHandler(async (req, res) => {
  const { conversationId, choice } = req.body; // choice: "primary" | "alternative"
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || conversation.userId !== req.userId) {
    return res.status(404).json({ error: 'Conversazione non trovata' });
  }
  const result = conversation.state.lastResult;
  const option = result?.[choice];
  if (!option || option.status !== 'ok') {
    return res.status(400).json({ error: 'Nessuna opzione valida da salvare per questa scelta' });
  }

  const itinerary = await prisma.itinerary.create({
    data: {
      userId: req.userId,
      conversationId,
      status: 'draft',
      totalCost: option.totalCost,
      flightCost: option.breakdown.flightCost,
      hotelCost: option.breakdown.hotelCost,
      activityCost: option.breakdown.activityCost,
      compromises: option.compromises || [],
      details: {
        flights: option.flights,
        hotel: { id: option.hotel.hotel.id, name: option.hotel.hotel.name, nights: option.hotel.nights },
        activities: option.activities,
        participants: conversation.state.requirements.participants,
      },
    },
  });

  res.status(201).json(itinerary);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const itinerary = await prisma.itinerary.findUnique({ where: { id: req.params.id } });
  if (!itinerary || itinerary.userId !== req.userId) {
    return res.status(404).json({ error: 'Itinerario non trovato' });
  }
  res.json(itinerary);
}));

export default router;
