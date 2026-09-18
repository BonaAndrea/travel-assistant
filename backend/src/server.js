import app from './app.js';
import { itineraryJobService } from './services/itineraryJobService.js';
import { prisma } from './db/prisma.js';
import { closeConversationAdvisoryPool } from './services/conversationAdvisoryLock.js';
import { validateEnvironment } from './config.js';

const config = validateEnvironment();
const server = app.listen(config.PORT, async () => {
  console.log(`Backend in ascolto su http://localhost:${config.PORT}`);
  try {
    const resumed = await itineraryJobService.resumePending();
    if (resumed > 0) console.log(`Ripresi ${resumed} job di generazione itinerario`);
  } catch (error) {
    console.error('Impossibile riprendere i job di generazione:', error.message);
  }
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Arresto graceful richiesto da ${signal}`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), closeConversationAdvisoryPool()]);
    clearTimeout(forceExit);
    process.exit(0);
  });
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
