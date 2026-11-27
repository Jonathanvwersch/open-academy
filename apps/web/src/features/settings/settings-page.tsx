import { studyDays } from '@open-academy/engine/api';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Check, LogOut } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { setAppShellHint } from '../../lib/app-shell-hint.js';
import { courseQueryKeyRoot, learnQueryOptions } from '../course/queries.js';
import { studyMapQueryOptions } from '../map/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { settingsQueryOptions } from './queries.js';

export function SettingsPage() {
  const { auth } = getRouteApi('__root__').useRouteContext();
  const queryClient = useQueryClient();
  const { data: settings } = useSuspenseQuery(settingsQueryOptions());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [draft, setDraft] = useState(settings);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    const submittedSettings = { ...draft };
    try {
      const response = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submittedSettings),
      });
      if (!response.ok) {
        setError('Settings could not be saved.');
        return;
      }
      queryClient.setQueryData(settingsQueryOptions().queryKey, submittedSettings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: courseQueryKeyRoot }),
        queryClient.invalidateQueries({ queryKey: studyMapQueryOptions().queryKey }),
      ]);
      setSaved(true);
    } catch {
      setError('Settings could not be saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };
  async function logout() {
    setAuthError('');
    setLoggingOut(true);
    try {
      const response = await apiFetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) {
        setAuthError('Could not log out.');
        return;
      }
      setAppShellHint(false);
      window.location.replace('/login');
    } catch {
      setAuthError('Could not log out. Check your connection and try again.');
    } finally {
      setLoggingOut(false);
    }
  }
  const weeklyMinutes = Object.values(draft.dailyMinutes).reduce(
    (sum, minutes) => sum + minutes,
    0,
  );
  const weeklyHours = Math.round((weeklyMinutes / 60) * 10) / 10;
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Settings</h1>
      <form onSubmit={save}>
        <Card>
          <CardHeader>
            <CardTitle>Weekly study goal</CardTitle>
            <CardDescription>Set how many minutes you aim to study each day.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {studyDays.map((day) => (
                <div key={day} className="grid gap-2.5">
                  <Label htmlFor={day}>{day[0].toUpperCase() + day.slice(1)}</Label>
                  <div className="relative">
                    <Input
                      id={day}
                      disabled={saving}
                      aria-label={`${day[0].toUpperCase() + day.slice(1)} study goal`}
                      type="number"
                      min={5}
                      max={600}
                      step={5}
                      value={draft.dailyMinutes[day]}
                      onChange={(event) => {
                        setSaved(false);
                        setDraft({
                          ...draft,
                          dailyMinutes: {
                            ...draft.dailyMinutes,
                            [day]: Number(event.target.value),
                          },
                        });
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
                Save goal
              </Button>
            </div>
          </CardFooter>
        </Card>
      </form>
      {auth?.authRequired ? (
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
                loading={loggingOut}
                onClick={() => void logout()}
              >
                <LogOut className="size-3.5" aria-hidden="true" />
                Log out
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
