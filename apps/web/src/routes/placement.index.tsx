import { createFileRoute } from '@tanstack/react-router';
import { PlacementPage } from '../features/placement/placement-page.js';

export const Route = createFileRoute('/placement/')({
  component: () => {
    const search = Route.useSearch();
    return <PlacementPage initialRunId={search.id} initialCourseId={search.course} />;
  },
});
