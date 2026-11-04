import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/map')({
  component: MapPage,
});

function MapPage() {
  return <h1 className="text-2xl font-semibold tracking-tight">Map</h1>;
}
