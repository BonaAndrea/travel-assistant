import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith('postgresql://'), 'DATABASE_URL deve usare PostgreSQL'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve avere almeno 32 caratteri'),
  FRONTEND_ORIGIN: z.string().url().default('http://localhost:8080'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
});

export function validateEnvironment(env = process.env) {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Configurazione ambiente non valida: ${details}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.startsWith('change-me-in-production')) {
    throw new Error('JWT_SECRET demo non consentito in produzione');
  }
  return parsed.data;
}
