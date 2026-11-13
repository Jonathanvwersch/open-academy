import { createFileRoute } from '@tanstack/react-router';
import { ReviewsPage } from '@/features/reviews/reviews-page.js';
import { RouteLoadError } from '../components/route-error.js';
import { ReviewsSkeleton } from '../components/skeletons.js';
import { reviewsQueryOptions } from '../features/reviews/queries.js';

export const Route = createFileRoute('/reviews')({
  pendingComponent: ReviewsSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(reviewsQueryOptions()),
  errorComponent: () => <RouteLoadError message="Reviews are unavailable." role="alert" />,
  component: ReviewsPage,
});
