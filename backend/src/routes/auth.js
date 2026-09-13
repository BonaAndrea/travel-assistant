import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createAuthRateLimiter } from '../middleware/authRateLimiter.js';

const router = Router();
router.use(createAuthRateLimiter());
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = 'refresh_token';

class RefreshTokenReuseError extends Error {}

function signAccessToken(userId) {
  return jwt.sign({ sub: userId, typ: 'access' }, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(64).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });
  return token;
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: '/api/auth',
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/api/auth' });
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

const registerSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(6),
  name: z.string().min(1),
});

router.post('/register', asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dati non validi', details: parsed.error.flatten() });
  }
  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Email già registrata' });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, passwordHash, name } });

  const accessToken = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.status(201).json({ token: accessToken, user: publicUser(user) });
}));

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string(),
});

router.post('/login', asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dati non validi' });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Credenziali non valide' });

  const accessToken = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  res.json({ token: accessToken, user: publicUser(user) });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE];
  if (!rawToken) return res.status(401).json({ error: 'Refresh token mancante' });

  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.expiresAt <= new Date()) {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Refresh token non valido o scaduto' });
  }

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Refresh token già utilizzato' });
  }

  const nextToken = crypto.randomBytes(64).toString('base64url');
  const nextTokenHash = hashRefreshToken(nextToken);
  try {
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) throw new RefreshTokenReuseError();
      await tx.refreshToken.create({
        data: {
          userId: stored.userId,
          tokenHash: nextTokenHash,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      });
    });
  } catch (err) {
    if (!(err instanceof RefreshTokenReuseError)) throw err;
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Refresh token già utilizzato' });
  }

  setRefreshCookie(res, nextToken);
  res.json({ token: signAccessToken(stored.userId), user: publicUser(stored.user) });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE];
  if (rawToken) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  clearRefreshCookie(res);
  res.status(204).send();
}));

export default router;
