import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { settingsQueryOptions } from '../queries.js';

export const Route = createFileRoute('/settings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQueryOptions()),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: settings } = useSuspenseQuery(settingsQueryOptions());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(settings);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      setError('Settings could not be saved.');
      return;
    }
    setSaved(true);
  };
  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Preferences</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Settings</h1>
      </div>
      <form onSubmit={save} className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
        <label className="block text-sm font-medium">
          Daily study time
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={draft.scheduleMinutes}
              onChange={(event) =>
                setDraft({ ...draft, scheduleMinutes: Number(event.target.value) })
              }
              className="w-28 rounded-md border border-neutral-300 px-3 py-2"
            />
            <span className="text-neutral-600">minutes</span>
          </div>
        </label>
        {(['saturdayMinutes', 'sundayMinutes'] as const).map((key) => (
          <label key={key} className="block text-sm font-medium">
            {key === 'saturdayMinutes' ? 'Saturday study time' : 'Sunday study time'}
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={600}
                step={5}
                value={draft[key]}
                onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
                className="w-28 rounded-md border border-neutral-300 px-3 py-2"
              />
              <span className="text-neutral-600">minutes</span>
            </div>
          </label>
        ))}
        <label className="block text-sm font-medium">
          Learning start date
          <input
            type="date"
            value={draft.startDate}
            onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
            className="mt-2 block rounded-md border border-neutral-300 px-3 py-2"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-green-800">
            Settings saved.
          </p>
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
        >
          Save settings
        </button>
      </form>
    </section>
  );
}
