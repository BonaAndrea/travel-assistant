import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import itineraryRoutes from './routes/itineraries.js';
import bookingRoutes from './routes/bookings.js';
import itineraryJobRoutes from './routes/itineraryJobs.js';
import preferenceImageRoutes from './routes/preferenceImages.js';
import shareLinkRoutes from './routes/shareLinks.js';
import { createMetricsEndpoint, createMetricsMiddleware } from './services/metrics.js';
import { logEvent } from './services/logger.js';
import { randomUUID } from 'node:crypto';
import { prisma } from './db/prisma.js';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:8080',
  credentials: true,
}));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb', strict: true }));
app.use(cookieParser());
app.use(createMetricsMiddleware());

// Logging essenziale, senza dati sensibili (no body/token loggati)
app.use((req, _res, next) => {
  req.requestId = randomUUID();
  // Il path grezzo può contenere UUID/ID di risorse: la route normalizzata è
  // già disponibile nelle metriche, qui manteniamo solo il contesto minimo.
  logEvent('http_request_started', { requestId: req.requestId, method: req.method });
  next();
});
app.use((req, res, next) => {
  res.on('finish', () => logEvent('http_request_completed', {
    requestId: req.requestId, method: req.method, status: res.statusCode,
  }));
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/live', (_req, res) => res.json({ status: 'ok', check: 'liveness' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', check: 'readiness' });
  } catch {
    res.status(503).json({ status: 'unavailable', check: 'readiness' });
  }
});
app.get('/api/metrics', createMetricsEndpoint());

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/chat', preferenceImageRoutes);
app.use('/api/itineraries', itineraryRoutes);
app.use('/api/itinerary-jobs', itineraryJobRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/share', shareLinkRoutes);

// Gestione errori centralizzata
app.use((err, req, res, _next) => {
  logEvent('http_request_error', {
    requestId: req.requestId, method: req.method,
    status: err.status || 500, error: err.code || err.name || 'UnhandledError',
  }, console.error);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Errore interno del server',
  });
});

export default app;
