const SAFE_KEYS = new Set([
  'requestId', 'method', 'path', 'status', 'durationMs', 'operation', 'jobId',
  'error', 'code', 'phase', 'outcome',
]);

function safeValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 160);
}

export function logEvent(event, fields = {}, logger = console.info) {
  try {
    const safeFields = Object.fromEntries(
      Object.entries(fields)
        .filter(([key, value]) => SAFE_KEYS.has(key) && value !== undefined)
        .map(([key, value]) => [key, safeValue(value)]),
    );
    logger(JSON.stringify({ event, ...safeFields }));
  } catch {
    // Il logging non deve mai interrompere il percorso applicativo.
  }
}
