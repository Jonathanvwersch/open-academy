import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { quizItems, quizRuns } from '../db/schema.js';

export async function linkTimedQuizFollowUp(
  db: Database,
  userId: string,
  activityId: string,
  reviewedConceptIds: string[],
) {
  await db
    .update(quizItems)
    .set({ followUpActivityId: activityId })
    .where(
      and(
        eq(quizItems.followUp, true),
        isNull(quizItems.followUpActivityId),
        inArray(quizItems.conceptId, reviewedConceptIds),
        inArray(
          quizItems.runId,
          db
            .select({ id: quizRuns.id })
            .from(quizRuns)
            .where(and(eq(quizRuns.userId, userId), isNotNull(quizRuns.finalizedAt))),
        ),
      ),
    );
}
