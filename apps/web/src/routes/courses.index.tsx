import { createFileRoute } from '@tanstack/react-router';
import { CoursesPage } from '@/features/course/courses-page.js';
import { PublicCoursesPage } from '@/features/landing/public-courses-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { PageSkeleton } from '../components/skeletons.js';
import { coursesQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/courses/')({
  pendingComponent: PageSkeleton,
  loader: ({ context }) => {
    if (context.auth?.authRequired && !context.auth.authenticated) return;
    return context.queryClient.ensureQueryData(coursesQueryOptions());
  },
  errorComponent: () => (
    <RouteLoadError
      message="The course catalogue is unavailable."
      className="text-sm text-destructive"
    />
  ),
  component: CoursesIndexPage,
});

function CoursesIndexPage() {
  const { auth } = Route.useRouteContext();
  return auth?.authRequired && !auth.authenticated ? <PublicCoursesPage /> : <CoursesPage />;
}
