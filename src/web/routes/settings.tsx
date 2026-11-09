import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert.js';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { Input } from '@/ui/input.js';
import { Label } from '@/ui/label.js';
import { apiFetch } from '../authenticated-fetch.js';
import { settingsQueryOptions } from '../queries.js';
import { PageSkeleton } from '../skeletons.js';

export const Route = createFileRoute('/settings')({
  pendingComponent: PageSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQueryOptions()),
  component: SettingsPage,
});

function SettingsPage() {
  const { data: settings } = useSuspenseQuery(settingsQueryOptions());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState<'logout' | 'logout-all' | null>(null);
  const [draft, setDraft] = useState(settings);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const response = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        setError('Settings could not be saved.');
        return;
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };
  async function logout(endpoint: 'logout' | 'logout-all') {
    setAuthError('');
    setLoggingOut(endpoint);
    try {
      const response = await apiFetch(`/api/auth/${endpoint}`, { method: 'POST' });
      if (!response.ok) {
        setAuthError('Could not log out.');
        return;
      }
      window.location.replace('/login');
    } finally {
      setLoggingOut(null);
    }
  }
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Settings</h1>
      <form onSubmit={save}>
        <Card>
          <CardHeader>
            <CardTitle>Study schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="scheduleMinutes">Daily study time</Label>
                <div className="relative">
                  <Input
                    id="scheduleMinutes"
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    value={draft.scheduleMinutes}
                    onChange={(event) =>
                      setDraft({ ...draft, scheduleMinutes: Number(event.target.value) })
                    }
                    className="w-full pr-12"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    min
                  </span>
                </div>
              </div>
              {(['saturdayMinutes', 'sundayMinutes'] as const).map((key) => (
                <div className="grid gap-2" key={key}>
                  <Label htmlFor={key}>
                    {key === 'saturdayMinutes' ? 'Saturday study time' : 'Sunday study time'}
                  </Label>
                  <div className="relative">
                    <Input
                      id={key}
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={draft[key]}
                      onChange={(event) =>
                        setDraft({ ...draft, [key]: Number(event.target.value) })
                      }
                      className="w-full pr-12"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      min
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="startDate">Learning start date</Label>
              <Input
                id="startDate"
                type="date"
                value={draft.startDate}
                onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
                className="w-48"
              />
            </div>
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
            <Button type="submit" loading={saving}>
              Save settings
            </Button>
          </CardContent>
        </Card>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {authError ? (
            <Alert variant="destructive">
              <AlertDescription>{authError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={loggingOut === 'logout'}
              disabled={loggingOut === 'logout-all'}
              onClick={() => void logout('logout')}
            >
              Log out
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={loggingOut === 'logout-all'}
              disabled={loggingOut === 'logout'}
              onClick={() => void logout('logout-all')}
            >
              Log out of all devices
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
