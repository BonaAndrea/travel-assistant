import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const hash = (value) => createHash('sha256').update(value).digest('hex');

router.post('/itineraries/:itineraryId', requireAuth, async (req, res) => {
  const itinerary = await prisma.itinerary.findFirst({ where: { id: req.params.itineraryId, userId: req.userId } });
  if (!itinerary) return res.status(404).json({ error: 'Itinerario non trovato' });
  const token = randomBytes(32).toString('base64url');
  await prisma.shareLink.create({ data: { tokenHash: hash(token), userId: req.userId, itineraryId: itinerary.id } });
  res.status(201).json({ token });
});

router.get('/public/:token', async (req, res) => {
  const link = await prisma.shareLink.findUnique({ where: { tokenHash: hash(req.params.token) }, include: { itinerary: true } });
  if (!link || link.revokedAt || link.itinerary.status === 'expired') return res.status(404).json({ error: 'Link non disponibile' });
  const { id, details, totalCost, flightCost, hotelCost, activityCost, compromises, createdAt } = link.itinerary;
  res.json({ id, details, totalCost, flightCost, hotelCost, activityCost, compromises, createdAt });
});

export default router;
