let redirectingToLogin = false;

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
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
