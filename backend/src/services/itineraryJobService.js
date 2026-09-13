import { prisma } from '../db/prisma.js';
import { generateItinerary } from './itineraryService.js';
import { logEvent } from './logger.js';

const publicJobFields = {
  id: true, conversationId: true, status: true, progress: true, progressLabel: true,
  result: true, error: true, createdAt: true, startedAt: true, completedAt: true, updatedAt: true,
};

function generationIssue(result, requirementsSnapshot) {
  return {
    errorCode: typeof result.errorCode === 'string' ? result.errorCode.slice(0, 80) : 'generation_unavailable',
    message: String(result.error || 'La combinazione richiesta non è disponibile nel catalogo.').slice(0, 1000),
    alternatives: Array.isArray(result.alternatives) ? result.alternatives.slice(0, 12) : [],
    availableReturns: Array.isArray(result.availableReturns) ? result.availableReturns.slice(0, 12) : [],
    requested: result.requested || null,
    outbound: result.outbound || null,
    requirementsSnapshot: structuredClone(requirementsSnapshot),
  };
}

function normalizeNoReturnResult(result, requirementsSnapshot) {
  if (result?.errorCode !== 'no_return') return result;
  const expectedReturnDate = result.requested?.expectedReturnDate
    || result.outbound?.expectedReturnDate;
  const expectedTime = Date.parse(expectedReturnDate || '');
  const outboundTime = Date.parse(result.requested?.date || result.outbound?.date || '');
  const durationDays = Number(result.requested?.durationDays ?? requirementsSnapshot.durationDays);
  const unique = new Map();
  for (const alternative of (result.availableReturns || result.alternatives || [])) {
    const time = Date.parse(alternative?.availableReturnDate || '');
    if (!Number.isFinite(time)) continue;
    if (Number.isFinite(outboundTime) && time <= outboundTime) continue;
    const availableReturnDate = new Date(time).toISOString();
    if (unique.has(availableReturnDate)) continue;
    const daysShift = Number.isFinite(expectedTime)
      ? Math.round((time - expectedTime) / 86400000) : null;
    unique.set(availableReturnDate, {
      ...alternative,
      availableReturnDate,
      ...(daysShift === null ? {} : {
        daysShift,
        resultingDurationDays: Number.isFinite(durationDays) ? durationDays + daysShift : null,
      }),
    });
  }
  const availableReturns = [...unique.values()]
    .sort((left, right) => left.availableReturnDate.localeCompare(right.availableReturnDate));
  const dates = availableReturns.map(({ availableReturnDate }) => availableReturnDate.slice(0, 10));
  const cleanError = String(result.error || 'La combinazione richiesta non è disponibile nel catalogo.')
    .replace(/\s*Ritorni disponibili dal catalogo:[^.]*\./gi, '')
    .trim();
  const error = `${cleanError}${dates.length ? ` Ritorni disponibili dal catalogo: ${dates.join(', ')}.` : ''}`;
  const requested = result.requested || (result.outbound ? {
    outbound: result.outbound,
    date: result.outbound.date || null,
    durationDays: Number.isFinite(durationDays) ? durationDays : null,
    expectedReturnDate: result.outbound.expectedReturnDate || null,
  } : null);
  return {
    ...result, error, alternatives: availableReturns, availableReturns,
    requested, outbound: result.outbound || requested?.outbound || null,
  };
}

function friendlyError(error) {
  if (error?.message && process.env.NODE_ENV !== 'production') return error.message;
  return 'Non è stato possibile generare l’itinerario. Riprova più tardi.';
}

export function createItineraryJobService({ db = prisma, generate = generateItinerary, scheduler = setImmediate } = {}) {
  const activeJobs = new Set();
  const updateProgress = (jobId, progress, progressLabel) => db.itineraryGenerationJob.update({
    where: { id: jobId }, data: { progress, progressLabel },
  });

  async function run(jobId) {
    if (activeJobs.has(jobId)) return;
    activeJobs.add(jobId);
    try {
      const claimed = await db.itineraryGenerationJob.updateMany({
        where: { id: jobId, status: 'queued' },
        data: { status: 'running', progress: 10, progressLabel: 'Avvio generazione', startedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      const job = await db.itineraryGenerationJob.findUnique({ where: { id: jobId } });
      const conversation = await db.conversation.findUnique({ where: { id: job.conversationId } });
      if (!conversation || conversation.userId !== job.userId) throw new Error('Conversazione non trovata');

      const requirementsSnapshot = structuredClone(job.result?.requirementsSnapshot || conversation.state.requirements);
      const generated = await generate(structuredClone(requirementsSnapshot), (progress, label) =>
        updateProgress(jobId, progress, label));
      const result = {
        ...normalizeNoReturnResult(generated, requirementsSnapshot),
        requirementsSnapshot,
      };
      if (result.error) {
        const issue = generationIssue(result, requirementsSnapshot);
        const failedState = { ...conversation.state, phase: 'confirming', generationIssue: issue };
        delete failedState.lastResult;
        await db.$transaction([
          db.itineraryGenerationJob.update({
            where: { id: jobId },
            data: { status: 'failed', progress: 100, progressLabel: 'Generazione non riuscita', error: result.error, result, completedAt: new Date() },
          }),
          db.conversation.updateMany({
            where: { id: conversation.id, state: { equals: conversation.state }, AND: {
              state: { path: ['requirements'], equals: requirementsSnapshot },
          } }, data: { state: failedState },
          }),
        ]);
        return;
      }

      await updateProgress(jobId, 90, 'Salvataggio proposta');
      await db.$transaction([
        db.itineraryGenerationJob.update({
          where: { id: jobId },
          data: { status: 'completed', progress: 100, progressLabel: 'Itinerario pronto', result, completedAt: new Date() },
        }),
        db.conversation.updateMany({
          where: { id: conversation.id, state: { equals: conversation.state }, AND: {
            state: { path: ['requirements'], equals: requirementsSnapshot },
          } },
          data: { state: { ...conversation.state, phase: 'itinerary_proposed', lastResult: result } },
        }),
      ]);
    } catch (error) {
      logEvent('itinerary_job_failed', {
        jobId, error: error?.code || error?.name || 'JobError',
      }, console.error);
      await db.itineraryGenerationJob.updateMany({
        where: { id: jobId, status: { in: ['queued', 'running'] } },
        data: { status: 'failed', progress: 100, progressLabel: 'Errore durante la generazione', error: friendlyError(error), completedAt: new Date() },
      });
    } finally {
      activeJobs.delete(jobId);
    }
  }

  const schedule = (jobId) => scheduler(() => run(jobId));

  async function createOrGet({ userId, conversationId, idempotencyKey }) {
    const lookup = { userId_idempotencyKey: { userId, idempotencyKey } };
    const existing = await db.itineraryGenerationJob.findUnique({ where: lookup, select: publicJobFields });
    if (existing) {
      if (existing.conversationId !== conversationId) {
        const error = new Error('Chiave di idempotenza già usata per un’altra conversazione');
        error.status = 409;
        throw error;
      }
      if (existing.status === 'queued') schedule(existing.id);
      return { job: existing, created: false };
    }
    try {
      const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation || conversation.userId !== userId) {
        const error = new Error('Conversazione non trovata');
        error.status = 404;
        throw error;
      }
      const job = await db.itineraryGenerationJob.create({
        data: { userId, conversationId, idempotencyKey,
          result: { requirementsSnapshot: structuredClone(conversation.state.requirements) } }, select: publicJobFields,
      });
      schedule(job.id);
      return { job, created: true };
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const job = await db.itineraryGenerationJob.findUnique({ where: lookup, select: publicJobFields });
      if (!job || job.conversationId !== conversationId) throw error;
      // In caso di richieste concorrenti, questa richiesta può essere quella che
      // osserva per prima il record creato dall'altra. Riaccodare qui rende il
      // recupero indipendente dall'ordine con cui i dispatcher ricevono le richieste.
      if (job.status === 'queued') schedule(job.id);
      return { job, created: false };
    }
  }

  const getForUser = (jobId, userId) => db.itineraryGenerationJob.findFirst({
    where: { id: jobId, userId }, select: publicJobFields,
  });
  const getByKey = (userId, idempotencyKey) => db.itineraryGenerationJob.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } }, select: publicJobFields,
  });
  async function resumePending() {
    const pending = await db.itineraryGenerationJob.findMany({
      where: { status: { in: ['queued', 'running'] } }, select: { id: true },
    });
    await db.itineraryGenerationJob.updateMany({
      where: { id: { in: pending.map((job) => job.id) }, status: 'running' },
      data: { status: 'queued', progressLabel: 'Ripresa dopo riavvio' },
    });
    pending.forEach((job) => schedule(job.id));
    return pending.length;
  }
  return { createOrGet, getForUser, getByKey, resumePending, run };
}

export const itineraryJobService = createItineraryJobService();
