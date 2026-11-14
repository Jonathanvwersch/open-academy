import { createFileRoute } from '@tanstack/react-router';
import { PlacementPage } from '../features/placement/placement-page.js';

export const Route = createFileRoute('/placement/')({
  component: () => <PlacementPage initialRunId={Route.useSearch().id} />,
});
