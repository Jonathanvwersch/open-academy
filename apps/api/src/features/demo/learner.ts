import { randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { users } from '../../db/schema.js';

export function createDemoLearnerResolver(db: Database, ttlHours: number) {
  let lastCleanup = Number.NEGATIVE_INFINITY;
  const creations = new Map<string, number[]>();
  return async (input: { cookie?: string; ip: string; timeZone: string; now: Date }) => {
    const timestamp = input.now.getTime();
    const cutoff = new Date(timestamp - ttlHours * 3_600_000);
    const parsedCookie = z.string().uuid().safeParse(input.cookie);
    if (parsedCookie.success) {
      const [user] = await db.select().from(users).where(eq(users.id, parsedCookie.data));
      if (user && user.createdAt >= cutoff) return { user, created: false };
    }
    for (const [ip, attempts] of creations) {
      const recent = attempts.filter((time) => time > timestamp - 3_600_000);
      if (recent.length) creations.set(ip, recent);
      else creations.delete(ip);
    }
    const attempts = creations.get(input.ip) ?? [];
    if (attempts.length >= 30) return null;
    attempts.push(timestamp);
    creations.set(input.ip, attempts);
    if (timestamp - lastCleanup >= 600_000) {
      lastCleanup = timestamp;
      await db.delete(users).where(lt(users.createdAt, cutoff));
    }
    const [user] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        displayName: 'Learner',
        timezone: input.timeZone,
        startDate: input.now.toISOString().slice(0, 10),
        prefs: { scheduleMinutes: 60 },
        createdAt: input.now,
      })
      .returning();
    if (!user) throw new Error('Could not create demo learner');
    return { user, created: true };
  };
}
