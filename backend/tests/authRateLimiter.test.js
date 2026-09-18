import { authRateLimitConfig, createAuthRateLimiter } from '../src/middleware/authRateLimiter.js';
import { jest } from '@jest/globals';

function response() {
  return {
    headers: {}, statusCode: 200, body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(ip, email) {
  return { ip, body: email === undefined ? {} : { email } };
}

function invoke(limiter, req) {
  const res = response();
  const next = jest.fn();
  limiter(req, res, next);
  return { res, next };
}

describe('auth rate limiter', () => {
  test('lascia passare il traffico normale sotto entrambi i limiti', () => {
    const limiter = createAuthRateLimiter({
      config: { windowMs: 60_000, ipMax: 3, accountMax: 2 }, now: () => 0,
    });
    expect(invoke(limiter, request('192.0.2.1', 'user@example.com')).next).toHaveBeenCalledTimes(1);
    expect(invoke(limiter, request('192.0.2.1', 'other@example.com')).next).toHaveBeenCalledTimes(1);
  });

  test('risponde 429 in modo coerente quando un IP supera il limite', () => {
    const limiter = createAuthRateLimiter({
      config: { windowMs: 60_000, ipMax: 2, accountMax: 10 }, now: () => 0,
    });
    invoke(limiter, request('192.0.2.1'));
    invoke(limiter, request('192.0.2.1'));
    const { res, next } = invoke(limiter, request('192.0.2.1'));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('60');
    expect(res.body).toEqual({
      error: 'Troppe richieste di autenticazione, riprova più tardi',
      code: 'AUTH_RATE_LIMITED', retryAfter: 60,
    });
  });

  test('limita lo stesso account anche da IP diversi e normalizza l’email', () => {
    const limiter = createAuthRateLimiter({
      config: { windowMs: 60_000, ipMax: 10, accountMax: 2 }, now: () => 0,
    });
    invoke(limiter, request('192.0.2.1', ' User@Example.com '));
    invoke(limiter, request('192.0.2.2', 'user@example.com'));
    const { res, next } = invoke(limiter, request('192.0.2.3', 'USER@example.com'));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
  });

  test('azzera i contatori alla scadenza della finestra', () => {
    let timestamp = 0;
    const limiter = createAuthRateLimiter({
      config: { windowMs: 1_000, ipMax: 1, accountMax: 1 }, now: () => timestamp,
    });
    invoke(limiter, request('192.0.2.1', 'user@example.com'));
    expect(invoke(limiter, request('192.0.2.1', 'user@example.com')).res.statusCode).toBe(429);
    timestamp = 1_000;
    const { res, next } = invoke(limiter, request('192.0.2.1', 'user@example.com'));
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('legge limiti configurabili dall’ambiente e rifiuta valori non validi', () => {
    expect(authRateLimitConfig({
      AUTH_RATE_LIMIT_WINDOW_MS: '5000', AUTH_RATE_LIMIT_IP_MAX: '20',
      AUTH_RATE_LIMIT_ACCOUNT_MAX: '4',
    })).toEqual({ windowMs: 5000, ipMax: 20, accountMax: 4 });
    expect(() => authRateLimitConfig({ AUTH_RATE_LIMIT_IP_MAX: '0' }))
      .toThrow('AUTH_RATE_LIMIT_IP_MAX deve essere un intero positivo');
  });
});
