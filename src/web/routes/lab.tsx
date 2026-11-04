import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/lab')({
  component: LabPage,
});

function LabPage() {
  return <h1 className="text-2xl font-semibold tracking-tight">Lab</h1>;
}
