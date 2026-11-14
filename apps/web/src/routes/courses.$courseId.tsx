import { createFileRoute } from '@tanstack/react-router';
import { CoursePage } from '@/features/course/course-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { PageSkeleton } from '../components/skeletons.js';
import { courseDetailQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/courses/$courseId')({
  pendingComponent: PageSkeleton,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(courseDetailQueryOptions(params.courseId)),
  errorComponent: () => (
    <RouteLoadError message="Your course is unavailable." className="text-sm text-destructive" />
  ),
  component: CoursePage,
});
