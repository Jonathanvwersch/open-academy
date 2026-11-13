import { getRouteApi } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Logo } from '../../components/ui/logo.js';

const Route = getRouteApi('/login');
function safeRedirectPath(path: string | undefined): string {
  if (!path?.startsWith('/') || path.startsWith('//')) return '/';
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const { redirect: destination } = Route.useSearch();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(result.error ?? 'Login failed.');
        return;
      }
      window.location.replace(safeRedirectPath(destination));
    } catch {
      setError('Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-sm gap-6">
        <CardHeader className="gap-3">
          <Logo className="size-8" />
          <CardTitle className="text-xl">Open Academy</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={login}>
            <div className="grid gap-2.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                className="h-10"
                aria-label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? (
              <Alert role="alert" variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button className="h-10 w-full" type="submit" loading={submitting}>
              Log in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
