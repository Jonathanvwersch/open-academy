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
    await Promise.all([
      context.queryClient.ensureQueryData(papersQueryOptions()),
      context.queryClient.ensureQueryData(todayQueryOptions()),
      ...session.activities
        .filter((activity) => activity.kind === 'lab' && activity.projectId)
        .map((activity) =>
          context.queryClient.ensureQueryData(projectQueryOptions(activity.projectId ?? '')),
        ),
    ]);
    const lessons = await Promise.all(
      session.activities.map((activity) =>
        ['learn', 'practice', 'remediate', 'transfer'].includes(activity.kind) &&
        activity.conceptId &&
        activity.lessonAvailable
          ? context.queryClient.ensureQueryData(lessonQueryOptions(activity.conceptId))
          : Promise.resolve(null),
      ),
    );
    await Promise.all(
      lessons.map((lesson, index) =>
        lesson?.knowledge_points?.length
          ? context.queryClient.ensureQueryData(
              lessonRunQueryOptions(session.activities[index]?.conceptId ?? null),
            )
          : Promise.resolve(null),
      ),
    );
    const exerciseIds = new Set(session.activities.flatMap((activity) => activity.exerciseIds));
    for (const lesson of lessons) {
      for (const block of lesson?.blocks ?? []) {
        if (block.exercise) exerciseIds.add(block.exercise);
      }
    }
    await Promise.all(
      [...exerciseIds].map((exerciseId) =>
        context.queryClient.ensureQueryData(exerciseQueryOptions(exerciseId)),
      ),
    );
  },
  errorComponent: () => (
    <RouteLoadError
      message="This session could not be resumed."
      className="text-sm text-destructive"
    />
  ),
  component: SessionPage,
});
