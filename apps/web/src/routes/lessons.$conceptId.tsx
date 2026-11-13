import { createFileRoute } from '@tanstack/react-router';
import { LessonReviewPage } from '@/features/lessons/lesson-review-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { LessonReviewSkeleton } from '../components/skeletons.js';
import { exerciseQueryOptions } from '../features/exercises/queries.js';
import { lessonReviewQueryOptions, lessonRunQueryOptions } from '../features/lessons/queries.js';

export const Route = createFileRoute('/lessons/$conceptId')({
  pendingComponent: LessonReviewSkeleton,
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
  loader: async ({ context, params }) => {
    const payload = await context.queryClient.ensureQueryData(
      lessonReviewQueryOptions(params.conceptId),
    );
    await context.queryClient.ensureQueryData(lessonRunQueryOptions(params.conceptId));
    await Promise.all(
      payload.lesson.blocks.flatMap((block) =>
        block.exercise
          ? [context.queryClient.ensureQueryData(exerciseQueryOptions(block.exercise))]
          : [],
      ),
    );
  },
  errorComponent: () => (
    <RouteLoadError
      message="This lesson could not be loaded."
      className="text-sm text-destructive"
    />
  ),
  component: LessonReviewPage,
});
