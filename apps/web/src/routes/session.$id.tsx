import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SessionPage } from '@/features/sessions/session-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { SessionSkeleton } from '../components/skeletons.js';
import { exerciseQueryOptions } from '../features/exercises/queries.js';
import { lessonQueryOptions, lessonRunQueryOptions } from '../features/lessons/queries.js';
import { papersQueryOptions } from '../features/papers/queries.js';
import { projectQueryOptions } from '../features/projects/queries.js';
import { sessionQueryOptions, todayQueryOptions } from '../features/sessions/queries.js';

export const Route = createFileRoute('/session/$id')({
  pendingComponent: SessionSkeleton,
  validateSearch: z.object({ activity: z.string().optional() }),
  loader: async ({ context, params }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
    const queryClient = context.queryClient;
    const loadLessons = session.activities.map(async (activity) => {
      if (
        !['learn', 'practice', 'remediate', 'transfer'].includes(activity.kind) ||
        !activity.conceptId ||
        !activity.lessonAvailable
      )
        return;
      // Run state does not depend on the lesson response. Start both requests together.
      const [lesson] = await Promise.all([
        queryClient.ensureQueryData(lessonQueryOptions(activity.conceptId)),
        activity.kind === 'learn'
          ? queryClient.ensureQueryData(lessonRunQueryOptions(activity.conceptId))
          : Promise.resolve(null),
      ]);
      await Promise.all([
        // Knowledge-point runs already include their current question. Legacy blocks still need exercise data.
        ...(lesson?.knowledge_points?.length
          ? []
          : (lesson?.blocks.flatMap((block) =>
              block.exercise
                ? [queryClient.ensureQueryData(exerciseQueryOptions(block.exercise))]
                : [],
            ) ?? [])),
      ]);
    });
    await Promise.all([
      ...loadLessons,
      ...session.activities
        .filter((activity) => activity.kind === 'lab' && activity.projectId)
        .map((activity) =>
          queryClient.ensureQueryData(projectQueryOptions(activity.projectId ?? '')),
        ),
      ...[...new Set(session.activities.flatMap((activity) => activity.exerciseIds))].map(
        (exerciseId) => queryClient.ensureQueryData(exerciseQueryOptions(exerciseId)),
      ),
      ...(session.activities.some((activity) => activity.kind === 'paper')
        ? [
            queryClient.ensureQueryData(papersQueryOptions()),
            queryClient.ensureQueryData(todayQueryOptions()),
          ]
        : []),
    ]);
  },
  errorComponent: () => (
    <RouteLoadError
      message="This session could not be resumed."
      className="text-sm text-destructive"
    />
  ),
  component: SessionPage,
});
