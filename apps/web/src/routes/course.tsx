import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { CoursePage } from '@/features/course/course-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { CourseSkeleton } from '../components/skeletons.js';
import { courseQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/course')({
  validateSearch: z.object({ course: z.string().optional() }),
  pendingComponent: CourseSkeleton,
  loaderDeps: ({ search }) => ({ course: search.course }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(courseQueryOptions(deps.course)),
  errorComponent: () => (
    <RouteLoadError message="Your course is unavailable." className="text-sm text-destructive" />
  ),
  component: CoursePage,
});
