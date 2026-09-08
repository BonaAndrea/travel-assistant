import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import itineraryRoutes from './routes/itineraries.js';
import bookingRoutes from './routes/bookings.js';

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:8080',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Logging essenziale, senza dati sensibili (no body/token loggati)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/itineraries', itineraryRoutes);
app.use('/api/bookings', bookingRoutes);

// Gestione errori centralizzata
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Errore interno del server',
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend in ascolto su http://localhost:${PORT}`));
