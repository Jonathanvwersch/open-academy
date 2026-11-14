import { desc, eq } from 'drizzle-orm';
import { masteryEvents, projectSubmissions, studySessions, xpEvents } from '../../db/schema.js';
import {
  filterMasteryRecordsForContent,
} from '../../learning/content-filters.js';
import { buildProgress } from '../../learning/progress.js';
import type { MasteryRecord } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getProgress(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const repo = request.repo;
  const [records, recent, events, flags, submissions, sessions, earnedXp] = await Promise.all([
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
    db
      .select({ amount: xpEvents.amount, localDate: xpEvents.localDate })
      .from(xpEvents)
      .where(eq(xpEvents.userId, request.userId)),
  ]);
  const contentAttempts = recent.filter((attempt) => {
    const exercise = index.exercisesById.get(attempt.exerciseId);
    return (
      index.conceptsById.has(attempt.conceptId) &&
      exercise?.concept === attempt.conceptId
    );
  });
  return serviceResult(
    buildProgress({
      content: index,
      records: filterMasteryRecordsForContent(index, records),
      events: events
        .filter((event) => index.conceptsById.has(event.conceptId))
        .map((event) => ({
          ...event,
          attemptId: event.attemptId ?? undefined,
          dimension: event.dimension as MasteryRecord['dimension'],
        })),
      attempts: contentAttempts.map((attempt) => ({
        ...attempt,
        dimension: attempt.dimension as MasteryRecord['dimension'],
      })),
      flags: flags.filter(
        (flag) =>
          index.conceptsById.has(flag.conceptId) &&
          (!flag.targetPrereqId || index.conceptsById.has(flag.targetPrereqId)),
      ),
      submissions: submissions.filter((submission) => index.projectsById.has(submission.projectId)),
      sessions,
      xpEvents: earnedXp,
      now: request.now(),
      timeZone: request.timeZone,
    }),
  );
}
