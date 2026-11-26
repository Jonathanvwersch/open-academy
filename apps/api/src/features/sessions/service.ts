import { sessionActivityIsInContent } from '@academy/aesop/graph/content-filters';
import { withReviewTopics } from '@academy/aesop/planner/home-plan';
import type { FeatureRequest, FeatureServices } from '../../service-context.js';
import { serviceResult } from '../../service-context.js';

export async function getSessionsActive(deps: FeatureServices, request: FeatureRequest) {
  const now = request.now();
  const session = await request.repo.activeSession(now);
  const index = await deps.content();
  const fullSession = session ? await request.repo.session(session.id, session) : null;
  const activities =
    fullSession?.activities.filter((activity) => sessionActivityIsInContent(index, activity)) ?? [];
  const inProgressReviewIds = activities
    .filter((activity) => activity.kind === 'review' && activity.status === 'in_progress')
    .map((activity) => activity.id);
  const attemptedByActivity =
    await request.repo.attemptedExerciseIdsByActivity(inProgressReviewIds);
  return serviceResult(
    fullSession && activities.length
      ? {
          ...fullSession,
          activities: activities.map((activity) =>
            withReviewTopics(
              {
                ...activity,
                conceptTitle: activity.conceptId
                  ? index.conceptsById.get(activity.conceptId)?.title
                  : undefined,
              },
              index,
              attemptedByActivity.get(activity.id),
            ),
          ),
          serverNow: now,
        }
      : null,
  );
}
