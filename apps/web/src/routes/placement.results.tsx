import { createFileRoute } from '@tanstack/react-router';
import { PlacementResultsPage } from '../features/placement/placement-results-page.js';

export const Route = createFileRoute('/placement/results')({
  component: () => <PlacementResultsPage runId={Route.useSearch().id} />,
});
