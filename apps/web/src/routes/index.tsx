import { createFileRoute } from '@tanstack/react-router';
import { LearnPage } from '@/features/course/learn-page.js';
import { LandingPage } from '@/features/landing/landing-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { LearnSkeleton } from '../components/skeletons.js';
import { learnQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/')({
  pendingComponent: LearnSkeleton,
  loader: async ({ context }) => {
    if (context.auth?.authRequired && !context.auth.authenticated) return;
    await context.queryClient.ensureQueryData(learnQueryOptions());
  },
  errorComponent: () => (
    <RouteLoadError
      message="Your learning plan is unavailable."
      className="text-sm text-destructive"
    />
  ),
  component: IndexPage,
});

function IndexPage() {
  const { auth } = Route.useRouteContext();
  return auth?.authRequired && !auth.authenticated ? <LandingPage /> : <LearnPage />;
}
