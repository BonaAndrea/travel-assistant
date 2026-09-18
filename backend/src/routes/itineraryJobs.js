import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { itineraryJobService } from '../services/itineraryJobService.js';

const createJobSchema = z.object({
  conversationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
});
const router = Router();
router.use(requireAuth);

router.post('/', asyncHandler(async (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'conversationId o idempotencyKey non validi' });
  const conversation = await prisma.conversation.findUnique({ where: { id: parsed.data.conversationId } });
  if (!conversation || conversation.userId !== req.userId) return res.status(404).json({ error: 'Conversazione non trovata' });
  const existing = await itineraryJobService.getByKey(req.userId, parsed.data.idempotencyKey);
  if (!existing && conversation.state.phase !== 'confirming') {
    return res.status(409).json({ error: 'La conversazione non è pronta per generare un itinerario' });
  }
  const { job, created } = await itineraryJobService.createOrGet({
    userId: req.userId, conversationId: conversation.id, idempotencyKey: parsed.data.idempotencyKey,
  });
  res.status(created ? 202 : 200).json({ job });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = await itineraryJobService.getForUser(req.params.id, req.userId);
  if (!job) return res.status(404).json({ error: 'Job non trovato' });
  res.json({ job });
}));

export default router;
