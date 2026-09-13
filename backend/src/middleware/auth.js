import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || typeof payload !== 'object' || payload.typ !== 'access'
      || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return res.status(401).json({ error: 'Token non valido o scaduto' });
    }
    req.userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}
