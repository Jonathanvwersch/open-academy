import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getSettings(deps: FeatureServices, request: FeatureRequest) {
  const { tutorProvider } = deps;
  const user = await request.repo.user();
  return serviceResult({
    scheduleMinutes: 60,
    saturdayMinutes: 300,
    sundayMinutes: 60,
    startDate: user?.startDate ?? '',
    ...(user?.prefs as object),
    tutorEnabled: tutorProvider !== null,
  });
}

export async function putSettings(deps: FeatureServices, request: FeatureRequest) {
  const { db } = deps;
  const body = z
    .object({
      scheduleMinutes: z.number().int().min(5).max(600),
      saturdayMinutes: z.number().int().min(5).max(600).optional(),
      sundayMinutes: z.number().int().min(5).max(600).optional(),
      startDate: z.string().min(1),
      goal: z.string().optional(),
    })
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid settings' }, 400);
  }
  const [updated] = await db
    .update(users)
    .set({ startDate: body.data.startDate, prefs: body.data })
    .where(eq(users.id, request.userId))
    .returning();
  return serviceResult(updated);
}
