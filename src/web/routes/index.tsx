import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { HealthResponseSchema } from '../../shared/health';

export const Route = createFileRoute('/')({
  component: TodayPage,
});

function TodayPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await fetch('/api/health');
      if (!response.ok) {
        throw new Error('Health check failed');
      }
      return HealthResponseSchema.parse(await response.json());
    },
  });

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
      {health.isPending ? <p className="text-sm text-neutral-600">Checking service…</p> : null}
      {health.isError ? <p className="text-sm text-red-700">Health check unavailable</p> : null}
      {health.data ? (
        <p className="text-sm text-neutral-600">
          Health: {health.data.ok ? 'OK' : 'Unavailable'} · Database:{' '}
          {health.data.db ? 'connected' : 'unavailable'}
        </p>
      ) : null}
    </section>
  );
}
