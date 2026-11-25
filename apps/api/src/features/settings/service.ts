import { dailyStudyMinutes, type SessionPreferences } from '@academy/aesop/planner/session-budget';
import { studyDays } from '@academy/contracts/settings';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { quizAccommodation } from '../quizzes/offer.js';

export async function getSettings(deps: FeatureServices, request: FeatureRequest) {
  const { tutorProvider } = deps;
  const user = await request.repo.user();
  return serviceResult({
    dailyMinutes: dailyStudyMinutes((user?.prefs ?? {}) as SessionPreferences),
    tutorEnabled: tutorProvider !== null,
    quizTimeMultiplier: quizAccommodation(user?.prefs),
  });
}

export async function putSettings(deps: FeatureServices, request: FeatureRequest) {
  const { db } = deps;
  const body = z
    .object({
      dailyMinutes: z.record(z.enum(studyDays), z.number().int().min(5).max(600)).optional(),
      scheduleMinutes: z.number().int().min(5).max(600).optional(),
      saturdayMinutes: z.number().int().min(5).max(600).optional(),
      sundayMinutes: z.number().int().min(5).max(600).optional(),
      startDate: z.iso.date().optional(),
      goal: z.string().optional(),
      quizTimeMultiplier: z.number().min(1).max(5).optional(),
    })
    .refine(
      (value) =>
        value.dailyMinutes !== undefined ||
        value.scheduleMinutes !== undefined ||
        value.quizTimeMultiplier !== undefined,
    )
    .safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid settings' }, 400);
  }
  const user = await request.repo.user();
  const { startDate, ...preferences } = body.data;
  const [updated] = await db
    .update(users)
    .set({
      ...(startDate === undefined ? {} : { startDate }),
      prefs: { ...(user?.prefs as object), ...preferences },
    })
    .where(eq(users.id, request.userId))
    .returning();
  return serviceResult(updated);
}
