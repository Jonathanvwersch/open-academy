import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/progress')({
  component: ProgressPage,
});

function ProgressPage() {
  return <h1 className="text-2xl font-semibold tracking-tight">Progress</h1>;
}
