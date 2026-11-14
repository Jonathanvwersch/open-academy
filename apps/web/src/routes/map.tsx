import { createFileRoute } from '@tanstack/react-router';
import { RouteLoadError } from '../components/route-error.js';
import { PageSkeleton } from '../components/skeletons.js';
import { MapPage } from '../features/map/map-page.js';
import { studyMapQueryOptions } from '../features/map/queries.js';

export const Route = createFileRoute('/map')({
  pendingComponent: PageSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(studyMapQueryOptions()),
  errorComponent: () => (
    <RouteLoadError message="The study map is unavailable." className="text-sm text-destructive" />
  ),
  component: MapPage,
});
