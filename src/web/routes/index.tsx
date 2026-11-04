import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: TodayPage,
});

interface TodayPayload {
  needsDiagnostic: boolean;
  diagnosticActive: boolean;
  diagnosticRunId: string | null;
  objective: string;
  weekTitle: string;
  week: number;
  dueReviews: number;
  budgetMinutes: number;
  activeSessionId: string | null;
  plan: {
    activities: Array<{
      kind: string;
      conceptId?: string;
      conceptTitle?: string;
      plannedMinutes: number;
      reason: { summary: string };
    }>;
  };
}

function TodayPage() {
  const today = useQuery({
    queryKey: ['today'],
    queryFn: async () => {
      const response = await fetch('/api/today');
      if (!response.ok) throw new Error('Could not load Today');
      return (await response.json()) as TodayPayload;
    },
  });
  const startSession = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetMinutes: today.data?.budgetMinutes ?? 60 }),
      });
      if (!response.ok) throw new Error('Could not start session');
      return response.json() as Promise<{ id: string }>;
    },
    onSuccess: ({ id }) => {
      window.location.href = `/session/${id}`;
    },
  });

  if (today.isPending) return <p className="text-sm text-neutral-600">Loading your plan…</p>;
  if (today.isError) return <p className="text-sm text-red-700">Your plan is unavailable.</p>;
  const plan = today.data;
  if (plan.needsDiagnostic) {
    return (
      <section className="mx-auto max-w-3xl space-y-8">
        <div>
          <p className="text-sm text-neutral-500">Week {plan.week}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Welcome to Academy</h2>
          <p className="mt-2 max-w-[70ch] text-sm leading-6 text-neutral-600">
            Begin with a short diagnostic so your first sessions start at the right level.
          </p>
          <a
            href={
              plan.diagnosticActive && plan.diagnosticRunId
                ? `/diagnostic?runId=${plan.diagnosticRunId}`
                : '/diagnostic'
            }
            className="mt-4 inline-flex rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
          >
            {plan.diagnosticActive ? 'Resume diagnostic' : 'Start diagnostic'}
          </a>
        </div>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-sm text-neutral-500">
            Week {plan.week} · {plan.weekTitle}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Today</h1>
        </div>
        <p className="text-sm text-neutral-600">
          {plan.dueReviews} review{plan.dueReviews === 1 ? '' : 's'} due
        </p>
      </div>
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Current week
        </p>
        <p className="mt-2 max-w-[70ch] text-base leading-7">{plan.objective}</p>
      </div>
      {plan.dueReviews > 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="font-semibold">Reviews due</h2>
          <ul className="mt-2 space-y-1 text-sm text-neutral-600">
            {plan.plan.activities
              .filter((activity) => activity.kind === 'review')
              .map((activity) => (
                <li
                  key={`${activity.kind}-${activity.conceptId ?? 'review'}-${activity.reason.summary}`}
                >
                  Review · {activity.conceptTitle ?? activity.conceptId ?? 'saved material'} ·{' '}
                  {activity.plannedMinutes} min
                </li>
              ))}
            {!plan.plan.activities.some((activity) => activity.kind === 'review') ? (
              <li>
                {plan.dueReviews} review{plan.dueReviews === 1 ? '' : 's'} ready to schedule.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {plan.activeSessionId ? (
        <a
          href={`/session/${plan.activeSessionId}`}
          className="inline-flex rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
        >
          Resume session
        </a>
      ) : (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">
              Planned session · {plan.budgetMinutes} minutes
            </h2>
            <ul className="mt-3 divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
              {plan.plan.activities.map((activity, index) => (
                <li
                  key={`${activity.kind}-${activity.conceptId ?? index}`}
                  className="flex items-start justify-between gap-4 p-4"
                >
                  <div>
                    <p className="font-medium capitalize">
                      {activity.kind.replace('_', ' ')}
                      {activity.conceptId
                        ? ` · ${activity.conceptTitle ?? activity.conceptId}`
                        : ''}
                    </p>
                    <p className="mt-1 text-sm text-neutral-600">{activity.reason.summary}</p>
                  </div>
                  <span className="shrink-0 text-sm text-neutral-500">
                    {activity.plannedMinutes} min
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {startSession.isPending ? 'Starting…' : 'Start session'}
          </button>
        </div>
      )}
    </section>
  );
}
