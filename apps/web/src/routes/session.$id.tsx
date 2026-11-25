import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { SessionPage } from '@/features/sessions/session-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { SessionSkeleton } from '../components/skeletons.js';
import { exerciseQueryOptions } from '../features/exercises/queries.js';
import { lessonQueryOptions, lessonRunQueryOptions } from '../features/lessons/queries.js';
import { papersQueryOptions } from '../features/papers/queries.js';
import { projectQueryOptions } from '../features/projects/queries.js';
import {
  sessionActivityCandidates,
  usesLessonRunner,
} from '../features/sessions/activity-selection.js';
import { sessionQueryOptions, todayQueryOptions } from '../features/sessions/queries.js';

export const Route = createFileRoute('/session/$id')({
  pendingComponent: SessionSkeleton,
  validateSearch: z.object({
    activity: z.string().optional(),
    step: z.union([z.string(), z.number()]).optional(),
  }),
  loaderDeps: ({ search }) => ({ activity: search.activity }),
  loader: async ({ context, params, deps }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
    const queryClient = context.queryClient;
    const candidates = sessionActivityCandidates(session.activities, deps.activity);
    const loadLessons = candidates.map(async (activity) => {
      if (
        !['learn', 'practice', 'remediate', 'transfer'].includes(activity.kind) ||
        !activity.conceptId ||
        !activity.lessonAvailable
      ) {
        await Promise.all(
          activity.exerciseIds.map((id) => queryClient.ensureQueryData(exerciseQueryOptions(id))),
        );
        return;
      }
      // Run state does not depend on the lesson response. Start both requests together.
      const [lesson] = await Promise.all([
        queryClient.ensureQueryData(lessonQueryOptions(activity.conceptId)),
        activity.kind === 'learn'
          ? queryClient.ensureQueryData(lessonRunQueryOptions(activity.conceptId, activity.id))
          : Promise.resolve(null),
      ]);
      await Promise.all([
        ...(usesLessonRunner(activity, lesson)
          ? []
          : activity.exerciseIds.map((id) =>
              queryClient.ensureQueryData(exerciseQueryOptions(id)),
            )),
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
      ...candidates
        .filter((activity) => activity.kind === 'lab' && activity.projectId)
        .map((activity) =>
          queryClient.ensureQueryData(projectQueryOptions(activity.projectId ?? '')),
        ),
      ...(candidates.some((activity) => activity.kind === 'paper')
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
  remountDeps: ({ params }) => params,
  component: SessionPage,
});
