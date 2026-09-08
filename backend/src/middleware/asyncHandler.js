/**
 * Express 4 non inoltra automaticamente le eccezioni delle Promise agli error handler:
 * senza questo wrapper, un errore in una route async (es. Groq irraggiungibile, query DB
 * fallita) risulterebbe in una promise rejection non gestita anziché in una risposta 500
 * pulita gestita dal middleware centralizzato in server.js.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
