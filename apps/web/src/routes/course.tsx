import { createFileRoute } from '@tanstack/react-router';
import { CoursePage } from '@/features/course/course-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { CourseSkeleton } from '../components/skeletons.js';
import { courseQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/course')({
  pendingComponent: CourseSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(courseQueryOptions()),
  errorComponent: () => (
    <RouteLoadError message="Your course is unavailable." className="text-sm text-destructive" />
  ),
  component: CoursePage,
});
