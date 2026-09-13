import { jest } from '@jest/globals';
import { APIConnectionError, APIConnectionTimeoutError } from 'groq-sdk';
import { CircuitOpenError, createLlmResilience, llmErrorFields, retryAfterMsFromError } from '../src/services/llmResilience.js';
import { createCompletionClient } from '../src/services/llmService.js';

const unavailable = () => Object.assign(new Error('Unavailable'), { status: 503 });

describe('Groq resilience', () => {
  let time;
  let sleep;
  let logger;
  let run;

  beforeEach(() => {
    time = 1000;
    sleep = jest.fn().mockResolvedValue(undefined);
    logger = jest.fn();
    run = createLlmResilience({ now: () => time, random: () => 0, sleep, logger });
  });

  test('propaga il Retry-After del provider invece del solo cooldown locale', () => {
    expect(retryAfterMsFromError({
      status: 429,
      message: 'Rate limit. Please try again in 5m29.6s.',
    })).toBe(329600);
    expect(retryAfterMsFromError({ headers: { 'retry-after': '12' } })).toBe(12000);
  });

  test('rende osservabili status e messaggio senza esporre credenziali', () => {
    expect(llmErrorFields({
      status: 401,
      message: 'Authorization Bearer gsk_example-secret?api_key=hidden',
    })).toEqual({
      error: 'unknown',
      errorStatus: 401,
      errorMessage: 'Authorization Bearer [redacted]',
    });
  });

  test('redige il prompt restituito negli errori di tool-calling', () => {
    const fields = llmErrorFields({
      status: 400,
      message: 'tool validation failed {"failed_generation":"budget 1000 per Roma"}',
    });
    expect(fields.errorMessage).toContain('failed_generation":"[redacted]');
    expect(fields.errorMessage).not.toContain('budget 1000');
  });

  test('recovers from rate limiting and server failures with exponential backoff', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValue('ok');
    await expect(run(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[125], [250]]);
    const events = logger.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.filter((event) => event.event === 'llm_retry')).toEqual([
      { event: 'llm_retry', provider: 'groq', attempt: 1, delayMs: 125, error: 'unknown', errorStatus: 429 },
      { event: 'llm_retry', provider: 'groq', attempt: 2, delayMs: 250, error: 'Error', errorStatus: 503, errorMessage: 'Unavailable' },
    ]);
  });

  test.each([400, 401, 403, 404, 422])('does not retry permanent HTTP %i errors', async (status) => {
    const error = { status };
    const operation = jest.fn().mockRejectedValue(error);
    await expect(run(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test.each([APIConnectionError, APIConnectionTimeoutError])('retries SDK %p', async (ErrorType) => {
    const operation = jest.fn().mockRejectedValueOnce(new ErrorType({})).mockResolvedValue('ok');
    await expect(run(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test('opens after three exhausted calls and allows one recovery probe', async () => {
    const operation = jest.fn().mockRejectedValue(unavailable());
    for (let i = 0; i < 3; i += 1) await expect(run(operation)).rejects.toMatchObject({ status: 503 });
    expect(operation).toHaveBeenCalledTimes(9);
    await expect(run(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).toHaveBeenCalledTimes(9);
    expect(logger.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'llm_circuit_open', failures: 3, cooldownMs: 30000 }),
      expect.objectContaining({ event: 'llm_circuit_blocked', retryAfterMs: 30000 }),
    ]));
    time += 30000;
    let resolve;
    const probe = run(() => new Promise((done) => { resolve = done; }));
    await expect(run(operation)).rejects.toBeInstanceOf(CircuitOpenError);
    resolve('recovered');
    await expect(probe).resolves.toBe('recovered');
    await expect(run(async () => 'healthy')).resolves.toBe('healthy');
  });

  test('failed recovery probe reopens immediately without retries', async () => {
    run = createLlmResilience({ now: () => time, sleep, failureThreshold: 1 });
    const operation = jest.fn().mockRejectedValue(unavailable());
    await expect(run(operation)).rejects.toMatchObject({ status: 503 });
    time += 30000;
    await expect(run(operation)).rejects.toMatchObject({ status: 503 });
    expect(operation).toHaveBeenCalledTimes(4);
    await expect(run(operation)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  test('a successful call resets consecutive failures', async () => {
    const operation = jest.fn().mockRejectedValue(unavailable());
    for (let i = 0; i < 2; i += 1) await expect(run(operation)).rejects.toMatchObject({ status: 503 });
    await run(async () => 'ok');
    for (let i = 0; i < 2; i += 1) await expect(run(operation)).rejects.toMatchObject({ status: 503 });
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });

  test('an older concurrent success cannot close a newly opened circuit', async () => {
    run = createLlmResilience({ now: () => time, sleep, failureThreshold: 1, maxRetries: 0 });
    let resolve;
    const pending = run(() => new Promise((done) => { resolve = done; }));
    await expect(run(async () => { throw unavailable(); })).rejects.toMatchObject({ status: 503 });
    resolve('ok');
    await pending;
    await expect(run(async () => 'ok')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  test('preserves model fallback and retries transient failures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const create = jest.fn()
        .mockRejectedValueOnce({ status: 404, message: 'model not found' })
        .mockRejectedValueOnce(unavailable())
        .mockRejectedValueOnce({ status: 404, message: 'model not found' })
        .mockResolvedValue('completion');
      const complete = createCompletionClient(create, ['configured', 'fallback'], run);
      await expect(complete({ messages: [] })).resolves.toBe('completion');
      expect(create.mock.calls.map(([payload]) => payload.model)).toEqual(['configured', 'fallback', 'configured', 'fallback']);
      expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
        { event: 'llm_model_fallback', provider: 'groq', model: 'configured', error: 'unknown', errorStatus: 404, errorMessage: 'model not found' },
        { event: 'llm_model_fallback', provider: 'groq', model: 'configured', error: 'unknown', errorStatus: 404, errorMessage: 'model not found' },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
