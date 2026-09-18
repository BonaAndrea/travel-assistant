import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-preference-images-'));
process.env.USER_PREFERENCE_IMAGE_DIR = storageDirectory;

const mockPrisma = {
  conversation: { findFirst: jest.fn(), create: jest.fn() },
  preferenceImage: {
    create: jest.fn(),
    findFirst: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma: mockPrisma }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.userId = req.headers['x-test-user'] || 'user-1';
    next();
  },
}));
jest.unstable_mockModule('../src/services/visionService.js', () => ({
  analyzePreferenceImage: jest.fn(async () => ({
    status: 'metadata_only', description: null, tags: [], reason: 'vision_disabled',
  })),
}));

const { default: preferenceImageRoutes } = await import('../src/routes/preferenceImages.js');

function createApp() {
  const app = express();
  app.use('/api/chat', preferenceImageRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('upload immagini preferenze', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-1' });
  });

  afterAll(async () => {
    await fs.rm(storageDirectory, { recursive: true, force: true });
  });

  test('valida il MIME tramite magic bytes, salva con nome casuale e restituisce metadati privati', async () => {
    mockPrisma.preferenceImage.create.mockImplementation(async ({ data }) => ({
      id: 'image-1', ...data, createdAt: new Date('2026-09-09T17:00:00Z'),
    }));

    const response = await request(createApp())
      .post('/api/chat/conversations/conversation-1/preferences/images')
      .set('x-test-user', 'user-1')
      .attach('image', png, { filename: 'preferenza.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.image).toMatchObject({
      id: 'image-1', conversationId: 'conversation-1', mimeType: 'image/png', sizeBytes: png.length,
      analysis: { status: 'metadata_only', extractedPreferences: [], usedAs: 'metadata_only' },
    });
    expect(response.body.image.url).toContain('/content');
    const storedFiles = await fs.readdir(storageDirectory);
    expect(storedFiles).toHaveLength(1);
    expect(storedFiles[0]).toMatch(/^[0-9a-f-]+\.png$/);
    expect(mockPrisma.preferenceImage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user-1', conversationId: 'conversation-1', mimeType: 'image/png' }),
    }));
  });

  test('rifiuta un contenuto che non corrisponde al MIME dichiarato', async () => {
    const response = await request(createApp())
      .post('/api/chat/conversations/conversation-1/preferences/images')
      .attach('image', Buffer.from('not-an-image'), { filename: 'fake.png', contentType: 'image/png' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_IMAGE');
    expect(mockPrisma.preferenceImage.create).not.toHaveBeenCalled();
  });

  test('applica il limite di 5 MiB prima del salvataggio', async () => {
    const response = await request(createApp())
      .post('/api/chat/conversations/conversation-1/preferences/images')
      .attach('image', Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]), {
        filename: 'large.png', contentType: 'image/png',
      });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('IMAGE_TOO_LARGE');
    expect(mockPrisma.preferenceImage.create).not.toHaveBeenCalled();
  });

  test('non consente upload su conversazione di altro utente', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(null);
    const response = await request(createApp())
      .post('/api/chat/conversations/other/preferences/images')
      .set('x-test-user', 'user-1')
      .attach('image', png, { filename: 'preferenza.png', contentType: 'image/png' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  test('materializza una conversazione transitoria quando l upload è la prima azione', async () => {
    const conversationId = '550e8400-e29b-41d4-a716-446655440000';
    mockPrisma.conversation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: conversationId });
    mockPrisma.conversation.create.mockResolvedValue({ id: conversationId });
    mockPrisma.preferenceImage.create.mockImplementation(async ({ data }) => ({
      id: 'image-pending-1', ...data, createdAt: new Date('2026-09-09T17:00:00Z'),
    }));

    const response = await request(createApp())
      .post(`/api/chat/conversations/${conversationId}/preferences/images`)
      .set('x-test-user', 'user-1')
      .attach('image', png, { filename: 'prima.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: conversationId, userId: 'user-1' }),
    }));
    expect(response.body.image.id).toBe('image-pending-1');
  });

  test('serve e cancella solo immagini appartenenti all’utente e alla conversazione', async () => {
    const storageKey = 'image-1.png';
    await fs.writeFile(path.join(storageDirectory, storageKey), png);
    const image = {
      id: 'image-1', conversationId: 'conversation-1', userId: 'user-1', storageKey,
      originalName: 'preferenza.png', mimeType: 'image/png', sizeBytes: png.length,
    };
    mockPrisma.preferenceImage.findFirst.mockResolvedValue(image);

    const content = await request(createApp())
      .get('/api/chat/conversations/conversation-1/preferences/images/image-1/content')
      .set('x-test-user', 'user-1');
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.from(content.body)).toEqual(png);

    const deleted = await request(createApp())
      .delete('/api/chat/conversations/conversation-1/preferences/images/image-1')
      .set('x-test-user', 'user-1');
    expect(deleted.status).toBe(204);
    expect(mockPrisma.preferenceImage.delete).toHaveBeenCalledWith({ where: { id: 'image-1' } });
    await expect(fs.access(path.join(storageDirectory, storageKey))).rejects.toThrow();
  });
});
