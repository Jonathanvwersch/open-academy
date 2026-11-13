import { createFileRoute } from '@tanstack/react-router';
import { ProgressPage } from '@/features/progress/progress-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { ProgressSkeleton } from '../components/skeletons.js';
import { progressQueryOptions } from '../features/progress/queries.js';

export const Route = createFileRoute('/progress')({
  pendingComponent: ProgressSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(progressQueryOptions()),
  errorComponent: () => <RouteLoadError message="Progress is unavailable." role="alert" />,
  component: ProgressPage,
});
