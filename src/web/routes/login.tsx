import { createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../authenticated-fetch.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Logo } from '../ui/logo.js';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: LoginPage,
});

function safeRedirectPath(path: string | undefined): string {
  if (!path?.startsWith('/') || path.startsWith('//')) return '/';
  try {
    const url = new URL(path, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

function LoginPage() {
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
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Logo className="size-8" />
          <CardTitle className="text-xl">Open Academy</CardTitle>
          <CardDescription>Enter your password to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={login}>
            <Label className="block space-y-2">
              Password
              <Input
                aria-label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Label>
            {error ? (
              <Alert role="alert" variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <Button className="w-full" type="submit" loading={submitting}>
              Log in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
