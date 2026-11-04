import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert.js';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { Input } from '@/ui/input.js';
import { Label } from '@/ui/label.js';
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
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Preferences</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Settings</h1>
      </div>
      <form onSubmit={save}>
        <Card>
          <CardContent className="space-y-5 p-6">
            <Label className="block space-y-2">
              Daily study time
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  value={draft.scheduleMinutes}
                  onChange={(event) =>
                    setDraft({ ...draft, scheduleMinutes: Number(event.target.value) })
                  }
                  className="w-28"
                />
                <span className="text-neutral-600">minutes</span>
              </div>
            </Label>
            {(['saturdayMinutes', 'sundayMinutes'] as const).map((key) => (
              <Label key={key} className="block space-y-2">
                {key === 'saturdayMinutes' ? 'Saturday study time' : 'Sunday study time'}
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    value={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}
                    className="w-28"
                  />
                  <span className="text-neutral-600">minutes</span>
                </div>
              </Label>
            ))}
            <Label className="block space-y-2">
              Learning start date
              <Input
                type="date"
                value={draft.startDate}
                onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
              />
            </Label>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {saved ? (
              <Alert role="status" className="border-green-300 bg-green-50 text-green-950">
                <AlertDescription className="text-inherit">Settings saved.</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit">Save settings</Button>
          </CardContent>
        </Card>
      </form>
    </section>
  );
}
