import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PlacementPage } from '../features/placement/placement-page.js';

export const Route = createFileRoute('/placement/')({
  validateSearch: z.object({ id: z.string().optional() }),
  component: () => <PlacementPage initialRunId={Route.useSearch().id} />,
});
