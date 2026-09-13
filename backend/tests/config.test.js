import { validateEnvironment } from '../src/config.js';

const valid = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://travel:travel@localhost:5432/travel_assistant',
  JWT_SECRET: 'a'.repeat(40),
  FRONTEND_ORIGIN: 'https://travel.example.test',
  PORT: '4000',
};

describe('configurazione ambiente', () => {
  test('normalizza una configurazione valida', () => {
    expect(validateEnvironment(valid)).toMatchObject({ PORT: 4000, NODE_ENV: 'production' });
  });

  test('fallisce con secret debole o database non PostgreSQL', () => {
    expect(() => validateEnvironment({ ...valid, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
    expect(() => validateEnvironment({ ...valid, DATABASE_URL: 'sqlite://local.db' })).toThrow('DATABASE_URL');
  });

  test('rifiuta il secret demo in produzione', () => {
    expect(() => validateEnvironment({ ...valid, JWT_SECRET: 'change-me-in-production'.padEnd(32, '!') }))
      .toThrow('demo non consentito');
  });
});
