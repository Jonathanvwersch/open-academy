import { createFileRoute } from '@tanstack/react-router';
import { CoursesPage } from '@/features/course/courses-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { PageSkeleton } from '../components/skeletons.js';
import { coursesQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/courses/')({
  pendingComponent: PageSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(coursesQueryOptions()),
  errorComponent: () => (
    <RouteLoadError
      message="The course catalogue is unavailable."
      className="text-sm text-destructive"
    />
  ),
  component: CoursesPage,
});
