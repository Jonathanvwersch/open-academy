import { z } from 'zod';
import { studyDays } from '../api/settings.js';
import { dailyStudyMinutes, type SessionPreferences } from '../planner/session-budget.js';
import { quizAccommodation } from '../quizzes/quiz-offer.js';
import type { Settings } from '../store/core-store.js';
import type { EngineRequest, EngineResult } from './types.js';
import { respond } from './types.js';

const settingsBody = z
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
  );

function settingsView(settings: Settings | undefined, tutorEnabled: boolean) {
  return {
    dailyMinutes: dailyStudyMinutes((settings?.prefs ?? {}) as SessionPreferences),
    tutorEnabled,
    quizTimeMultiplier: quizAccommodation(settings?.prefs),
  };
}

export async function settingsOperation(request: EngineRequest): Promise<EngineResult> {
  return respond(settingsView(await request.repo.settings(), request.tutorEnabled));
}

export async function saveSettingsOperation(
  request: EngineRequest,
  input: unknown,
): Promise<EngineResult> {
  const body = settingsBody.safeParse(input);
  if (!body.success) return respond({ error: 'Invalid settings' }, 400);
  const settings = await request.repo.settings();
  const { startDate, ...preferences } = body.data;
  const saved = await request.store.transaction(async (tx) => {
    await tx.patchSettings(request.userId, {
      ...(startDate === undefined ? {} : { startDate }),
      prefs: { ...settings?.prefs, ...preferences },
    });
    return tx.getSettings(request.userId);
  });
  return respond(settingsView(saved, request.tutorEnabled));
}
