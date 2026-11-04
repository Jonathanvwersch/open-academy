import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { progressQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/progress')({
  loader: ({ context }) => context.queryClient.ensureQueryData(progressQueryOptions()),
  errorComponent: () => <RouteLoadError message="Progress is unavailable." role="alert" />,
  component: ProgressPage,
});

const masteryStateLabels: Record<string, string> = {
  not_assessed: 'Not assessed',
  introduced: 'Introduced',
  assisted: 'Assisted',
  independent: 'Independent',
  retained: 'Retained',
};

function ProgressPage() {
  const { data } = useSuspenseQuery(progressQueryOptions());
  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Learning overview</p>
        <h1 className="mt-1 text-3xl font-semibold">Progress</h1>
      </div>
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-semibold">90-day goals</h2>
        <p className="mt-2">
          {data.goal.mastered} of {data.goal.total} concepts independent or retained
        </p>
        <progress
          className="mt-2 w-full"
          max={Math.max(1, data.goal.total)}
          value={data.goal.mastered}
        />
      </section>
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-semibold">Mastery by domain</h2>
        {data.domains.map((domain) => (
          <div className="mt-4 border-t pt-3" key={domain.id}>
            <h3 className="font-medium">{domain.title}</h3>
            {Object.values(domain.counts).every((count) => count === 0) ? (
              <p className="text-sm text-neutral-600">No lessons authored yet</p>
            ) : (
              <p className="text-sm text-neutral-600">
                {Object.entries(domain.counts)
                  .map(([state, count]) => `${masteryStateLabels[state] ?? state}: ${count}`)
                  .join(' · ')}
              </p>
            )}
          </div>
        ))}
      </section>
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-semibold">Learning debt</h2>
        {data.debt.length ? (
          <ul className="mt-3 space-y-3">
            {data.debt.map((item) => (
              <li key={`${item.conceptId}-${item.dimension}-${item.reason}`}>
                <a className="font-medium text-blue-700 underline" href={item.studyUrl}>
                  Study {item.title} now
                </a>
                <p className="text-sm text-neutral-600">
                  {item.reason.replaceAll('_', ' ')} · {item.dimension}: {item.remediationAction}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-600">No learning debt identified.</p>
        )}
      </section>
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-semibold">Study time</h2>
        <p className="mt-2">
          {data.hours.toFixed(1)} of {data.planHours} hours · {data.streakDays}-day current streak
        </p>
      </section>
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-semibold">Recent evidence</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {data.evidence.map((item) => (
            <li key={item.id}>
              Attempt {item.exerciseId} ({item.conceptTitle}) → {item.correct} credit ·{' '}
              {new Date(item.createdAt).toLocaleDateString()} ·{' '}
              {item.event ?? 'no mastery-state change'}
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
