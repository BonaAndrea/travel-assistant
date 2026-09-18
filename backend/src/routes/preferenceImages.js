import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  MAX_PREFERENCE_IMAGE_BYTES,
  preferenceImageExtension,
  readPreferenceImage,
  removePreferenceImage,
  serializePreferenceImage,
  storePreferenceImage,
} from '../services/preferenceImageService.js';
import { analyzePreferenceImage } from '../services/visionService.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PREFERENCE_IMAGE_BYTES, files: 1, fields: 0 },
});

function uploadMiddleware(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ code: 'IMAGE_TOO_LARGE', error: 'L’immagine supera il limite di 5 MiB' });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FIELD_COUNT'
      || error.code === 'LIMIT_PART_COUNT') {
      return res.status(400).json({ code: 'INVALID_MULTIPART', error: 'Invia una sola immagine nel campo multipart "image"' });
    }
    return res.status(400).json({ code: 'INVALID_MULTIPART', error: 'Richiesta multipart non valida' });
  });
}

function publicImage(image, conversationId) {
  return serializePreferenceImage({ ...image, conversationId });
}

router.post('/conversations/:conversationId/preferences/images', uploadMiddleware, asyncHandler(async (req, res) => {
  const { conversationId } = req.params;
  let conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.userId },
    select: { id: true },
  });
  if (!conversation) {
    if (!z.string().uuid().safeParse(conversationId).success) {
      return res.status(404).json({ code: 'CONVERSATION_NOT_FOUND', error: 'Conversazione non trovata' });
    }
    // Il POST /conversations emette intenzionalmente un UUID transitorio. Un
    // upload può essere la prima azione: materializziamo qui la Conversation,
    // mantenendo ownership e lo stesso stato iniziale del primo turno chat.
    try {
      conversation = await prisma.conversation.create({
        data: { id: conversationId, userId: req.userId, state: { phase: 'collecting', requirements: {} } },
        select: { id: true },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.userId },
        select: { id: true },
      });
    }
  }
  if (!conversation) return res.status(404).json({ code: 'CONVERSATION_NOT_FOUND', error: 'Conversazione non trovata' });
  if (!req.file) return res.status(400).json({ code: 'IMAGE_REQUIRED', error: 'Campo multipart "image" mancante' });

  let stored;
  try {
    stored = await storePreferenceImage(req.file);
  } catch (error) {
    return res.status(error.status || 400).json({ code: error.code || 'INVALID_IMAGE', error: error.message });
  }

  try {
    const image = await prisma.preferenceImage.create({
      data: {
        userId: req.userId,
        conversationId,
        storageKey: stored.storageKey,
        originalName: String(req.file.originalname || 'image').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'image',
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        analysisStatus: 'metadata_only',
        tags: [],
      },
    });
    const analysis = await analyzePreferenceImage({ buffer: req.file.buffer, mimeType: stored.mimeType });
    let analyzedImage = { ...image, ...analysis };
    if (analysis.status === 'completed') {
      try {
        analyzedImage = await prisma.preferenceImage.update({
          where: { id: image.id },
          data: {
            analysisStatus: 'completed',
            description: analysis.description,
            tags: analysis.tags,
            analyzedAt: new Date(),
          },
        });
      } catch {
        // L'upload resta valido anche se il salvataggio dell'analisi non riesce.
        analyzedImage = { ...image, analysisStatus: 'metadata_only', analysisReason: 'analysis_persistence_error' };
      }
    } else {
      analyzedImage.analysisReason = analysis.reason;
    }
    return res.status(201).json({ image: publicImage(analyzedImage, conversationId) });
  } catch (error) {
    await removePreferenceImage(stored.storageKey).catch(() => {});
    throw error;
  }
}));

router.get('/conversations/:conversationId/preferences/images/:imageId/content', asyncHandler(async (req, res) => {
  const image = await prisma.preferenceImage.findFirst({
    where: { id: req.params.imageId, conversationId: req.params.conversationId, userId: req.userId },
  });
  if (!image) return res.status(404).json({ code: 'IMAGE_NOT_FOUND', error: 'Immagine non trovata' });

  try {
    const content = await readPreferenceImage(image.storageKey);
    res.type(image.mimeType);
    res.set('Content-Disposition', `inline; filename="preference-image${preferenceImageExtension(image.mimeType)}"`);
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(content);
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ code: 'IMAGE_NOT_FOUND', error: 'File immagine non disponibile' });
    throw error;
  }
}));

router.delete('/conversations/:conversationId/preferences/images/:imageId', asyncHandler(async (req, res) => {
  const image = await prisma.preferenceImage.findFirst({
    where: { id: req.params.imageId, conversationId: req.params.conversationId, userId: req.userId },
  });
  if (!image) return res.status(404).json({ code: 'IMAGE_NOT_FOUND', error: 'Immagine non trovata' });

  await prisma.preferenceImage.delete({ where: { id: image.id } });
  await removePreferenceImage(image.storageKey);
  return res.status(204).send();
}));

export { publicImage };
export default router;
