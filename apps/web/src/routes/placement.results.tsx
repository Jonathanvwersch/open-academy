import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PlacementResultsPage } from '../features/placement/placement-results-page.js';

export const Route = createFileRoute('/placement/results')({
  validateSearch: z.object({ id: z.string().optional() }),
  component: () => <PlacementResultsPage runId={Route.useSearch().id} />,
});
