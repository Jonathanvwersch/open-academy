import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { authSessions } from '../../db/schema.js';

const COOKIE_NAME = 'academy_session';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const YEAR_MS = COOKIE_MAX_AGE * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_IP_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 30;

export interface AuthOptions {
  password: string;
}

interface AuthDependencies {
  db: Database;
  auth?: AuthOptions | null;
  now?: () => Date;
  demo?: { ttlHours: number } | null;
}

const loginBodySchema = z.object({ password: z.string().max(200) });

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function passwordMatches(candidate: string, configured: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const configuredDigest = createHash('sha256').update(configured).digest();
  return timingSafeEqual(candidateDigest, configuredDigest);
}

export function isSecureRequest(context: Context): boolean {
  const forwardedProto = context.req
    .header('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim()
    .toLowerCase();
  return forwardedProto === 'https' || new URL(context.req.url).protocol === 'https:';
}

function setSessionCookie(context: Context, token: string): void {
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    secure: isSecureRequest(context),
  });
}

function clearSessionCookie(context: Context): void {
  deleteCookie(context, COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isSecureRequest(context),
  });
}

export function requestIp(context: Context): string {
  const forwardedFor = context.req.header('x-forwarded-for');
  const forwardedIp = forwardedFor?.split(',')[0]?.trim();
  if (forwardedIp) return forwardedIp;
  return context.env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export function createAuth({
  db,
  auth = null,
  now = () => new Date(),
  demo = null,
}: AuthDependencies) {
  const failuresByIp = new Map<string, number[]>();
  const globalFailures: number[] = [];

  function pruneAttempts(attempts: number[], cutoff: number): void {
    while (attempts.length && attempts[0] <= cutoff) attempts.shift();
  }

  function isRateLimited(ip: string, currentTime: number): boolean {
    const cutoff = currentTime - WINDOW_MS;
    pruneAttempts(globalFailures, cutoff);
    for (const [address, attempts] of failuresByIp) {
      pruneAttempts(attempts, cutoff);
      if (!attempts.length) failuresByIp.delete(address);
    }
    const attempts = failuresByIp.get(ip) ?? [];
    return attempts.length >= MAX_IP_FAILURES || globalFailures.length >= MAX_GLOBAL_FAILURES;
  }

  function recordFailure(ip: string, currentTime: number): void {
    const attempts = failuresByIp.get(ip) ?? [];
    attempts.push(currentTime);
    failuresByIp.set(ip, attempts);
    globalFailures.push(currentTime);
  }

  async function authenticated(context: Context): Promise<boolean> {
    if (!auth) return false;
    const token = getCookie(context, COOKIE_NAME);
    if (!token) return false;
    const hash = tokenHash(token);
    const [session] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hash))
      .limit(1);
    const currentTime = now();
    if (!session || session.expiresAt.getTime() <= currentTime.getTime()) return false;
    if (!session.lastSeenAt || currentTime.getTime() - session.lastSeenAt.getTime() > DAY_MS) {
      await db
        .update(authSessions)
        .set({
          lastSeenAt: currentTime,
          expiresAt: new Date(currentTime.getTime() + YEAR_MS),
        })
        .where(eq(authSessions.tokenHash, hash));
      setSessionCookie(context, token);
    }
    return true;
  }

  const middleware: MiddlewareHandler = async (context, next) => {
    const path = context.req.path;
    const method = context.req.method.toUpperCase();
    if (
      !auth ||
      path === '/api/health' ||
      (path === '/api/auth/login' && method === 'POST') ||
      (path === '/api/auth/me' && method === 'GET')
    ) {
      await next();
      return;
    }
    if (!(await authenticated(context))) {
      return context.json({ error: 'unauthenticated' }, 401);
    }
    await next();
  };

  const routes = new Hono();

  routes.post('/login', async (context) => {
    if (!auth) return context.json({ ok: true });
    const currentTime = now();
    const ip = requestIp(context);
    if (isRateLimited(ip, currentTime.getTime())) {
      return context.json({ error: 'Too many attempts, try again later' }, 429);
    }
    const body = loginBodySchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: 'Invalid request' }, 400);
    if (!passwordMatches(body.data.password, auth.password)) {
      recordFailure(ip, currentTime.getTime());
      return context.json({ error: 'Wrong password' }, 401);
    }

    failuresByIp.delete(ip);
    const token = randomBytes(32).toString('base64url');
    await db.insert(authSessions).values({
      tokenHash: tokenHash(token),
      expiresAt: new Date(currentTime.getTime() + YEAR_MS),
      lastSeenAt: currentTime,
    });
    setSessionCookie(context, token);
    return context.json({ ok: true });
  });

  routes.get('/me', async (context) => {
    const isAuthenticated = auth ? await authenticated(context) : false;
    return context.json({ authenticated: isAuthenticated, authRequired: Boolean(auth), demo });
  });

  routes.post('/logout', async (context) => {
    const token = getCookie(context, COOKIE_NAME);
    if (token && auth) {
      await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash(token)));
    }
    clearSessionCookie(context);
    return context.json({ ok: true });
  });

  routes.post('/logout-all', async (context) => {
    if (auth) await db.delete(authSessions);
    clearSessionCookie(context);
    return context.json({ ok: true });
  });

  return { middleware, routes };
}
