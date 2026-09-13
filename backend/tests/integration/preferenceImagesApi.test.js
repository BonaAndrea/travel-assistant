import { beforeEach, afterAll, expect, test } from '@jest/globals';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
  || database.hostname !== '127.0.0.1'
  || database.pathname !== '/travel_assistant_test'
  || database.username !== 'travel_test') {
  throw new Error('Use npm run test:integration to provision an isolated test database');
}

const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-preference-api-'));
process.env.USER_PREFERENCE_IMAGE_DIR = storageDirectory;
process.env.GROQ_VISION_ENABLED = 'false';
const { default: app } = await import('../../src/app.js');
const { prisma } = await import('../../src/db/prisma.js');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(async () => {
  for (const model of ['booking', 'preferenceImage', 'itineraryGenerationJob', 'itinerary', 'message',
    'conversation', 'refreshToken', 'user']) {
    await prisma[model].deleteMany();
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm(storageDirectory, { recursive: true, force: true });
});

test('upload immagini autenticato con isolamento, download e cancellazione reali', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    email: 'image-user@example.test', password: 'secret1', name: 'Image User',
  });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'image-user@example.test' } });
  const conversation = await prisma.conversation.create({
    data: { userId: user.id, state: { phase: 'collecting', requirements: {} } },
  });

  const uploaded = await request(app)
    .post(`/api/chat/conversations/${conversation.id}/preferences/images`)
    .set('Authorization', `Bearer ${token}`)
    .attach('image', png, { filename: 'preferenza.png', contentType: 'image/png' });
  expect(uploaded.status).toBe(201);
  expect(uploaded.body.image.mimeType).toBe('image/png');
  expect(await prisma.preferenceImage.count()).toBe(1);

  const content = await request(app)
    .get(uploaded.body.image.url.replace('/api', '/api'))
    .set('Authorization', `Bearer ${token }`);
  expect(content.status).toBe(200);
  expect(Buffer.from(content.body)).toEqual(png);

  const deleted = await request(app)
    .delete(`/api/chat/conversations/${conversation.id}/preferences/images/${uploaded.body.image.id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(deleted.status).toBe(204);
  expect(await prisma.preferenceImage.count()).toBe(0);
});

test('supporta upload come prima azione sulla conversazione transitoria', async () => {
  const registration = await request(app).post('/api/auth/register').send({
    email: 'pending-image-user@example.test', password: 'secret1', name: 'Pending Image User',
  });
  expect(registration.status).toBe(201);
  const token = registration.body.token;
  const prepared = await request(app)
    .post('/api/chat/conversations')
    .set('Authorization', `Bearer ${token}`);
  expect(prepared.status).toBe(201);
  expect(prepared.body.conversationId).toMatch(/^[0-9a-f-]{36}$/i);

  const uploaded = await request(app)
    .post(`/api/chat/conversations/${prepared.body.conversationId}/preferences/images`)
    .set('Authorization', `Bearer ${token}`)
    .attach('image', png, { filename: 'prima-azione.png', contentType: 'image/png' });
  expect(uploaded.status).toBe(201);
  expect(uploaded.body.image.conversationId).toBe(prepared.body.conversationId);
  expect(await prisma.conversation.count()).toBe(1);
});
