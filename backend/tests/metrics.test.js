import { EventEmitter } from 'node:events';
import {
  createMetricsEndpoint, createMetricsMiddleware, createMetricsRegistry, metricErrorCategory,
} from '../src/services/metrics.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(authorization) {
  return { get(name) { return name.toLowerCase() === 'authorization' ? authorization : undefined; } };
}

describe('metriche aggregate', () => {
  test('misura status e durata HTTP usando la route normalizzata', () => {
    const registry = createMetricsRegistry({ buckets: [1000] });
    const middleware = createMetricsMiddleware(registry);
    const req = { method: 'GET', baseUrl: '/api/bookings', path: '/abc', route: { path: '/:id' } };
    const res = new EventEmitter();
    res.statusCode = 200;
    middleware(req, res, () => {});
    res.emit('finish');
    expect(registry.snapshot().counters).toEqual([{
      name: 'http_requests_total', labels: { method: 'GET', route: '/api/bookings/:id', status: '200' }, value: 1,
    }]);
  });

  test('registra contatori e istogrammi con label non personali', () => {
    const registry = createMetricsRegistry({ now: () => '2026-09-09T00:00:00.000Z', buckets: [100, 1000] });
    registry.increment('http_requests_total', { route: '/api/bookings/:id', status: 200, userId: 'segreto' });
    registry.observe('http_request_duration_ms', 42, { route: '/api/bookings/:id', status: 200 });
    const snapshot = registry.snapshot();
    expect(snapshot.counters).toEqual([{ name: 'http_requests_total', labels: { route: '/api/bookings/:id', status: '200' }, value: 1 }]);
    expect(snapshot.histograms[0]).toMatchObject({ count: 1, sum: 42, buckets: { '100': 1, '1000': 1 } });
  });

  test('protegge l’endpoint exporter e non espone il token', () => {
    const registry = createMetricsRegistry({ now: () => 'now' });
    registry.increment('auth_rate_limit_blocked_total', { route: '/api/auth/login', reason: 'ip' });
    const endpoint = createMetricsEndpoint({ registry, token: 'metric-secret' });

    const unauthorized = response();
    endpoint(request('Bearer wrong'), unauthorized);
    expect(unauthorized.statusCode).toBe(401);

    const authorized = response();
    endpoint(request('Bearer metric-secret'), authorized);
    expect(authorized.statusCode).toBe(200);
    expect(JSON.stringify(authorized.body)).not.toContain('metric-secret');
    expect(authorized.body.counters[0].value).toBe(1);
  });

  test('disabilita l’exporter quando il token non è configurato', () => {
    const res = response();
    createMetricsEndpoint({ token: '' })(request(), res);
    expect(res.statusCode).toBe(404);
  });

  test('classifica gli errori senza usare il messaggio personale', () => {
    expect(metricErrorCategory({ code: 'GROQ_CIRCUIT_OPEN', message: 'token personale' }))
      .toBe('GROQ_CIRCUIT_OPEN');
    expect(metricErrorCategory(new Error('email@example.com'))).toBe('unknown');
  });
});
