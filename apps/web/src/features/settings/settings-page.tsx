import { useSuspenseQuery } from '@tanstack/react-query';
import { Check, LogOut } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { settingsQueryOptions } from './queries.js';

export function SettingsPage() {
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
    } catch {
      setError('Settings could not be saved. Check your connection and try again.');
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
    } catch {
      setAuthError('Could not log out. Check your connection and try again.');
    } finally {
      setLoggingOut(null);
    }
  }
  const weeklyMinutes = draft.scheduleMinutes * 5 + draft.saturdayMinutes + draft.sundayMinutes;
  const weeklyHours = Math.round((weeklyMinutes / 60) * 10) / 10;
  const studyDays = [
    { key: 'scheduleMinutes', label: 'Daily study time', title: 'Weekdays' },
    { key: 'saturdayMinutes', label: 'Saturday study time', title: 'Saturday' },
    { key: 'sundayMinutes', label: 'Sunday study time', title: 'Sunday' },
  ] as const;
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Settings</h1>
      <form onSubmit={save}>
        <Card>
          <CardHeader>
            <CardTitle>Study schedule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              {studyDays.map(({ key, label, title }) => (
                <div key={key} className="grid gap-2.5">
                  <Label htmlFor={key}>{title}</Label>
                  <div className="relative">
                    <Input
                      id={key}
                      aria-label={label}
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={draft[key]}
                      onChange={(event) => {
                        setSaved(false);
                        setDraft({ ...draft, [key]: Number(event.target.value) });
                      }}
                      className="h-12 bg-background pl-3.5 pr-13 text-xl font-medium tabular-nums md:text-xl"
                    />
                    <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      min
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <Label htmlFor="startDate">Start date</Label>
              <Input
                id="startDate"
                type="date"
                aria-label="Learning start date"
                value={draft.startDate}
                onChange={(event) => {
                  setSaved(false);
                  setDraft({ ...draft, startDate: event.target.value });
                }}
                className="h-10 w-full bg-background sm:w-44"
              />
            </div>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="flex-wrap justify-between gap-3">
            <p className="text-xs tabular-nums text-muted-foreground">{weeklyHours} hours / week</p>
            <div className="flex items-center gap-3">
              <span
                role="status"
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                {saved ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" />
                    Saved
                  </>
                ) : null}
              </span>
              <Button type="submit" loading={saving} className="h-9 px-4">
                Save settings
              </Button>
            </div>
          </CardFooter>
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
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-9"
              loading={loggingOut === 'logout'}
              disabled={loggingOut === 'logout-all'}
              onClick={() => void logout('logout')}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              Log out
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9"
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
