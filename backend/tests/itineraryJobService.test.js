import { jest } from '@jest/globals';
import { createItineraryJobService } from '../src/services/itineraryJobService.js';

function createFakeDb() {
  const jobs = new Map();
  const conversation = {
    id: 'conversation-1', userId: 'user-1',
    state: { phase: 'confirming', requirements: { country: 'Spagna' } },
  };
  const select = (job) => job && { ...job };
  const db = {
    itineraryGenerationJob: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return select(jobs.get(where.id));
        const key = where.userId_idempotencyKey;
        return select([...jobs.values()].find((job) => job.userId === key.userId && job.idempotencyKey === key.idempotencyKey));
      }),
      findFirst: jest.fn(async ({ where }) => select([...jobs.values()].find((job) => job.id === where.id && job.userId === where.userId))),
      findMany: jest.fn(async ({ where }) => [...jobs.values()]
        .filter((job) => where.status.in.includes(job.status)).map((job) => ({ id: job.id }))),
      create: jest.fn(async ({ data }) => {
        const job = { id: `job-${jobs.size + 1}`, status: 'queued', progress: 0, progressLabel: 'In coda', ...data };
        jobs.set(job.id, job);
        return select(job);
      }),
      update: jest.fn(({ where, data }) => {
        const operation = async () => {
          const job = jobs.get(where.id);
          Object.assign(job, data);
          return select(job);
        };
        return operation();
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const job = where.id?.in ? undefined : jobs.get(where.id);
        if (where.id?.in) {
          let count = 0;
          for (const id of where.id.in) {
            const candidate = jobs.get(id);
            const allowed = Array.isArray(where.status?.in) ? where.status.in.includes(candidate?.status) : candidate?.status === where.status;
            if (candidate && allowed) { Object.assign(candidate, data); count += 1; }
          }
          return { count };
        }
        const allowed = Array.isArray(where.status?.in) ? where.status.in.includes(job?.status) : job?.status === where.status;
        if (!job || !allowed) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
    },
    conversation: {
      findUnique: jest.fn(async () => structuredClone(conversation)),
      updateMany: jest.fn(async ({ where, data }) => {
        if (JSON.stringify(conversation.state) !== JSON.stringify(where.state.equals)
          || JSON.stringify(conversation.state.requirements) !== JSON.stringify(where.AND.state.equals)) return { count: 0 };
        conversation.state = structuredClone(data.state);
        return { count: 1 };
      }),
      update: jest.fn(({ data }) => {
        const operation = async () => {
          conversation.state = data.state;
          return { ...conversation };
        };
        return operation();
      }),
    },
    $transaction: jest.fn(async (operations) => Promise.all(operations)),
  };
  return { db, jobs, conversation };
}

describe('ciclo completo job itinerario', () => {
  test('crea una sola richiesta idempotente e completa il job con avanzamento e risultato', async () => {
    const { db, jobs, conversation } = createFakeDb();
    const scheduled = [];
    const result = { primary: { status: 'ok', withinBudget: true }, alternative: null };
    const generate = jest.fn(async (_requirements, onProgress) => {
      await onProgress(20, 'Ricerca voli');
      await onProgress(70, 'Selezione attività');
      return result;
    });
    const service = createItineraryJobService({ db, generate, scheduler: (callback) => scheduled.push(callback) });

    const first = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'request-123' });
    const duplicate = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'request-123' });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(jobs.size).toBe(1);

    await scheduled[0]();
    const completed = await service.getForUser(first.job.id, 'user-1');
    expect(completed).toMatchObject({ status: 'completed', progress: 100, progressLabel: 'Itinerario pronto', result });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(conversation.state).toMatchObject({ phase: 'itinerary_proposed', lastResult: result });
  });

  test('espone un errore funzionale e permette di correggere i requisiti', async () => {
    const { db, conversation } = createFakeDb();
    conversation.state.lastResult = { primary: { status: 'ok' } };
    const scheduled = [];
    const service = createItineraryJobService({
      db,
      generate: async () => ({ errorCode: 'no_return', error: 'Nessun volo disponibile Ritorni disponibili dal catalogo: 2026-07-12, 2026-07-12.', alternatives: [
        { availableReturnDate: '2026-07-12T00:00:00.000Z' },
        { availableReturnDate: '2026-07-12T00:00:00.000Z' },
      ] }),
      scheduler: (callback) => scheduled.push(callback),
    });
    const { job } = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'request-456' });
    await scheduled[0]();

    const failed = await service.getForUser(job.id, 'user-1');
    expect(failed).toMatchObject({
      status: 'failed', progress: 100,
      error: 'Nessun volo disponibile Ritorni disponibili dal catalogo: 2026-07-12.',
    });
    expect(conversation.state.phase).toBe('confirming');
    expect(conversation.state.generationIssue).toEqual({
      errorCode: 'no_return',
      message: 'Nessun volo disponibile Ritorni disponibili dal catalogo: 2026-07-12.',
      alternatives: [{ availableReturnDate: '2026-07-12T00:00:00.000Z' }],
      availableReturns: [{ availableReturnDate: '2026-07-12T00:00:00.000Z' }],
      requested: null,
      outbound: null,
      requirementsSnapshot: { country: 'Spagna' },
    });
    expect(conversation.state.lastResult).toBeUndefined();
  });

  test('scarta dai job i ritorni precedenti alla partenza e deduplica le date', async () => {
    const { db } = createFakeDb();
    const scheduled = [];
    const service = createItineraryJobService({
      db,
      generate: async () => ({
        errorCode: 'no_return', error: 'Nessun ritorno compatibile',
        requested: {
          date: '2026-11-22T00:00:00.000Z', durationDays: 7,
          expectedReturnDate: '2026-11-29T00:00:00.000Z', outbound: null,
        },
        alternatives: [
          { availableReturnDate: '2026-11-13T00:00:00.000Z' },
          { availableReturnDate: '2026-11-20T00:00:00.000Z' },
          { availableReturnDate: '2026-11-30T00:00:00.000Z' },
          { availableReturnDate: '2026-11-30T00:00:00.000Z' },
        ],
      }),
      scheduler: (callback) => scheduled.push(callback),
    });
    const { job } = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'request-filter' });
    await scheduled[0]();
    const failed = await service.getForUser(job.id, 'user-1');
    expect(failed.result.availableReturns).toEqual([{
      availableReturnDate: '2026-11-30T00:00:00.000Z', daysShift: 1, resultingDurationDays: 8,
    }]);
    expect(failed.result.alternatives).toEqual(failed.result.availableReturns);
    expect(failed.error).toContain('2026-11-30');
    expect(failed.error).not.toContain('2026-11-13');
    expect(failed.error).not.toContain('2026-11-20');
  });

  test('non rende consultabile il job a un altro utente', async () => {
    const { db } = createFakeDb();
    const service = createItineraryJobService({ db, scheduler: () => {} });
    const { job } = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'request-789' });
    await expect(service.getForUser(job.id, 'user-2')).resolves.toBeUndefined();
  });

  test('uses the queued requirements snapshot and never restores requirements changed before execution', async () => {
    const { db, conversation } = createFakeDb();
    const generate = jest.fn(async () => ({ primary: { status: 'ok' } }));
    const service = createItineraryJobService({ db, generate, scheduler: () => {} });
    const { job } = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'queued-change' });
    conversation.state = { phase: 'collecting', requirements: { country: 'Italia', participants: 3 } };
    const current = structuredClone(conversation.state);
    await service.run(job.id);
    expect(generate.mock.calls[0][0]).toEqual({ country: 'Spagna' });
    expect(conversation.state).toEqual(current);
    expect((await service.getForUser(job.id, 'user-1')).result.requirementsSnapshot).toEqual({ country: 'Spagna' });
  });

  test.each([false, true])('a job finishing after a correction preserves current state (failure=%s)', async (failure) => {
    const { db, conversation } = createFakeDb();
    const corrected = { phase: 'collecting', requirements: { participants: 3 } };
    const service = createItineraryJobService({ db, scheduler: () => {}, generate: async () => {
      conversation.state = structuredClone(corrected);
      return failure ? { error: 'No availability' } : { primary: { status: 'ok' } };
    } });
    const { job } = await service.createOrGet({ userId: 'user-1', conversationId: 'conversation-1', idempotencyKey: 'running-change' });
    await service.run(job.id);
    expect(conversation.state).toEqual(corrected);
    expect((await service.getForUser(job.id, 'user-1')).status).toBe(failure ? 'failed' : 'completed');
  });

  test('riaccoda i job sospesi e riconduce quelli running allo stato queued', async () => {
    const { db, jobs, conversation } = createFakeDb();
    const scheduled = [];
    const service = createItineraryJobService({ db, scheduler: (callback) => scheduled.push(callback) });
    const first = await service.createOrGet({ userId: 'user-1', conversationId: conversation.id, idempotencyKey: 'resume-one' });
    const second = await service.createOrGet({ userId: 'user-1', conversationId: conversation.id, idempotencyKey: 'resume-two' });
    jobs.get(first.job.id).status = 'running';
    jobs.get(second.job.id).status = 'queued';
    scheduled.length = 0;

    await expect(service.resumePending()).resolves.toBe(2);
    expect(jobs.get(first.job.id)).toMatchObject({ status: 'queued', progressLabel: 'Ripresa dopo riavvio' });
    expect(jobs.get(second.job.id).status).toBe('queued');
    expect(scheduled).toHaveLength(2);
  });
});
