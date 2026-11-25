import { dailyStudyMinutes, type SessionPreferences } from '@academy/aesop/planner/session-budget';
import { quizAccommodation } from '@academy/aesop/quizzes/quiz-offer';
import { studyDays } from '@academy/contracts/settings';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { users } from '../../db/schema.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getSettings(deps: FeatureServices, request: FeatureRequest) {
  const { tutorProvider } = deps;
  const settings = await request.repo.settings();
  return serviceResult({
    dailyMinutes: dailyStudyMinutes((settings?.prefs ?? {}) as SessionPreferences),
    tutorEnabled: tutorProvider !== null,
    quizTimeMultiplier: quizAccommodation(settings?.prefs),
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
  const settings = await request.repo.settings();
  const { startDate, ...preferences } = body.data;
  const updated = await db.transaction(async (tx) => {
    await drizzleLearnerStore(tx).patchSettings(request.userId, {
      ...(startDate === undefined ? {} : { startDate }),
      prefs: { ...settings?.prefs, ...preferences },
    });
    const [row] = await tx.select().from(users).where(eq(users.id, request.userId));
    return row;
  });
  return serviceResult(updated);
}
