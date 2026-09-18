import { beforeEach, afterEach, afterAll, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';

const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.TRAVEL_INTEGRATION_TEST !== 'isolated-postgres'
  || database.hostname !== '127.0.0.1' || database.pathname !== '/travel_assistant_test'
  || database.username !== 'travel_test') throw new Error('Use npm run test:integration');
const { prisma } = await import('../../src/db/prisma.js');
const { createItineraryJobService } = await import('../../src/services/itineraryJobService.js');
let user;
let conversation;
beforeEach(async () => {
  user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, name: 'Snapshot test', passwordHash: 'unused' } });
  conversation = await prisma.conversation.create({ data: {
    userId: user.id, state: { phase: 'confirming', requirements: { country: 'Spagna', participants: 2 } },
  } });
});
afterEach(async () => {
  if (!user) return;
  await prisma.itineraryGenerationJob.deleteMany({ where: { userId: user.id } });
  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
});
afterAll(async () => { await prisma.$disconnect(); });

test('Postgres JSON compare-and-set publishes the original proposal with its snapshot', async () => {
  const service = createItineraryJobService({ db: prisma, scheduler: () => {},
    generate: async () => ({ primary: { status: 'ok' } }) });
  const { job } = await service.createOrGet({ userId: user.id, conversationId: conversation.id, idempotencyKey: randomUUID() });
  await service.run(job.id);
  const current = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  expect(current.state.phase).toBe('itinerary_proposed');
  expect(current.state.lastResult.requirementsSnapshot).toEqual(conversation.state.requirements);
  expect((await service.getForUser(job.id, user.id)).status).toBe('completed');
});

test.each([false, true])('Postgres prevents job completion from overwriting changed requirements (failure=%s)', async (failure) => {
  const corrected = { phase: 'collecting', requirements: { country: 'Italia', participants: 3 } };
  const service = createItineraryJobService({ db: prisma, scheduler: () => {}, generate: async () => {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { state: corrected } });
    return failure ? { error: 'No flights' } : { primary: { status: 'ok' } };
  } });
  const { job } = await service.createOrGet({ userId: user.id, conversationId: conversation.id, idempotencyKey: randomUUID() });
  await service.run(job.id);
  const current = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  expect(current.state).toEqual(corrected);
  const completed = await service.getForUser(job.id, user.id);
  expect(completed.status).toBe(failure ? 'failed' : 'completed');
  expect(completed.result.requirementsSnapshot).toEqual(conversation.state.requirements);
});
