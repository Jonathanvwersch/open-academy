import { desc, eq } from 'drizzle-orm';
import { masteryEvents, projectSubmissions, studySessions } from '../../db/schema.js';
import { buildProgress } from '../../learning/progress.js';
import type { MasteryRecord } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getProgress(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const repo = request.repo;
  const [records, recent, events, flags, submissions, sessions] = await Promise.all([
    repo.masteryRecords(),
    repo.recentAttempts(100),
    db
      .select()
      .from(masteryEvents)
      .where(eq(masteryEvents.userId, request.userId))
      .orderBy(desc(masteryEvents.createdAt))
      .limit(100),
    repo.openFlags(),
    db
      .select()
      .from(projectSubmissions)
      .where(eq(projectSubmissions.userId, request.userId))
      .orderBy(desc(projectSubmissions.createdAt))
      .limit(50),
    db.select().from(studySessions).where(eq(studySessions.userId, request.userId)),
  ]);
  return serviceResult(
    buildProgress({
      content: index,
      records,
      events: events.map((event) => ({
        ...event,
        attemptId: event.attemptId ?? undefined,
        dimension: event.dimension as MasteryRecord['dimension'],
      })),
      attempts: recent.map((attempt) => ({
        ...attempt,
        dimension: attempt.dimension as MasteryRecord['dimension'],
      })),
      flags,
      submissions,
      sessions,
      now: request.now(),
      timeZone: request.timeZone,
    }),
  );
}
