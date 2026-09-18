import { expect, test } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app.js';

test('health probes distinguono liveness e readiness PostgreSQL', async () => {
  const live = await request(app).get('/health/live');
  expect(live.status).toBe(200);
  expect(live.body).toEqual({ status: 'ok', check: 'liveness' });

  const ready = await request(app).get('/health/ready');
  expect(ready.status).toBe(200);
  expect(ready.body).toEqual({ status: 'ok', check: 'readiness' });
});
