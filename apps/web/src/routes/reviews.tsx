import { createFileRoute } from '@tanstack/react-router';
import { ReviewsPage } from '@/features/reviews/reviews-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { ReviewsSkeleton } from '../components/skeletons.js';
import { reviewsQueryOptions } from '../features/reviews/queries.js';
import { todayQueryOptions } from '../features/sessions/queries.js';

export const Route = createFileRoute('/reviews')({
  pendingComponent: ReviewsSkeleton,
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(reviewsQueryOptions()),
      context.queryClient.ensureQueryData(todayQueryOptions()),
    ]),
  errorComponent: () => <RouteLoadError message="Reviews are unavailable." role="alert" />,
  component: ReviewsPage,
});
