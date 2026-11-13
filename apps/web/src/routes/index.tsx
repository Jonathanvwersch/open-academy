import { createFileRoute } from '@tanstack/react-router';
import { LearnPage } from '@/features/course/learn-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { LearnSkeleton } from '../components/skeletons.js';
import { learnQueryOptions } from '../features/course/queries.js';

export const Route = createFileRoute('/')({
  pendingComponent: LearnSkeleton,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(learnQueryOptions());
  },
  errorComponent: () => (
    <RouteLoadError
      message="Your learning plan is unavailable."
      className="text-sm text-destructive"
    />
  ),
  component: LearnPage,
});
