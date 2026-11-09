let redirectingToLogin = false;

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.set('X-Time-Zone', Intl.DateTimeFormat().resolvedOptions().timeZone);
  const response = await fetch(input, { ...init, headers });
  if (
    response.status === 401 &&
    typeof window !== 'undefined' &&
    window.location.pathname !== '/login' &&
    !redirectingToLogin
  ) {
    redirectingToLogin = true;
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/login?redirect=${encodeURIComponent(redirect)}`);
  }
  return response;
}
