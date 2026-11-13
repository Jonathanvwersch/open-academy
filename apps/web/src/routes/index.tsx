import { createFileRoute } from '@tanstack/react-router';
import { LearnPage } from '@/features/course/learn-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { LearnSkeleton } from '../components/skeletons.js';
import { learnQueryOptions } from '../features/course/queries.js';
import { todayQueryOptions } from '../features/sessions/queries.js';

export const Route = createFileRoute('/')({
  pendingComponent: LearnSkeleton,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(learnQueryOptions()),
      context.queryClient.ensureQueryData(todayQueryOptions()),
    ]);
  },
  errorComponent: () => (
    <RouteLoadError
      message="Your learning plan is unavailable."
      className="text-sm text-destructive"
    />
  ),
  component: LearnPage,
});
