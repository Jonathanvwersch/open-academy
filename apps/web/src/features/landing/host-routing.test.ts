import { describe, expect, it } from 'vitest';
import { resolveHostRoute } from './host-routing.js';

const appUrl = (path: string) => `https://app.openacademy.dev${path}`;
const siteUrl = (path: string) => `https://openacademy.dev${path}`;
const resolve = (
  overrides: Partial<Parameters<typeof resolveHostRoute>[0]> &
    Pick<Parameters<typeof resolveHostRoute>[0], 'role' | 'pathname'>,
) =>
  resolveHostRoute({
    search: '',
    appUrl,
    siteUrl,
    ...overrides,
  });

describe('resolveHostRoute', () => {
  it.each(['/', '/courses', '/how-it-works/'])(
    'renders public site path %s without auth',
    (pathname) => {
      expect(resolve({ role: 'site', pathname })).toEqual({ type: 'render', auth: undefined });
    },
  );

  it('sends non-public site paths to the app with their search preserved', () => {
    expect(
      resolve({
        role: 'site',
        pathname: '/lessons/vectors',
        search: '?step=2&from=plan',
      }),
    ).toEqual({
      type: 'redirect',
      href: 'https://app.openacademy.dev/lessons/vectors?step=2&from=plan',
      reloadDocument: true,
    });
  });

  it('sends the login path on the site to the app', () => {
    expect(resolve({ role: 'site', pathname: '/login' })).toEqual({
      type: 'redirect',
      href: 'https://app.openacademy.dev/login',
      reloadDocument: true,
    });
  });

  it('sends signed-out app-home visitors to login without a redirect search parameter', () => {
    expect(
      resolve({
        role: 'app',
        pathname: '/',
        auth: { authRequired: true, authenticated: false },
      }),
    ).toEqual({ type: 'redirect', to: '/login' });
  });

  it('keeps the redirect destination for other signed-out app paths', () => {
    expect(
      resolve({
        role: 'app',
        pathname: '/courses',
        search: '?sort=popular',
        auth: { authRequired: true, authenticated: false },
      }),
    ).toEqual({
      type: 'redirect',
      to: '/login',
      search: { redirect: '/courses?sort=popular' },
    });
  });

  it('sends the app how-it-works path to the public site', () => {
    expect(resolve({ role: 'app', pathname: '/how-it-works' })).toEqual({
      type: 'redirect',
      href: 'https://openacademy.dev/how-it-works',
      reloadDocument: true,
    });
  });

  it('renders signed-in app routes', () => {
    const auth = { authRequired: true, authenticated: true };
    expect(resolve({ role: 'app', pathname: '/lessons/vectors', auth })).toEqual({
      type: 'render',
      auth,
    });
  });

  it('redirects passwordless app visitors away from login', () => {
    expect(
      resolve({
        role: 'app',
        pathname: '/login',
        auth: { authRequired: false, authenticated: false },
      }),
    ).toEqual({ type: 'redirect', to: '/' });
  });

  it('redirects signed-in app users away from login', () => {
    expect(
      resolve({
        role: 'app',
        pathname: '/login',
        auth: { authRequired: true, authenticated: true },
      }),
    ).toEqual({ type: 'redirect', to: '/' });
  });

  it('preserves combined-host public and protected-route behavior', () => {
    const signedOutAuth = { authRequired: true, authenticated: false };
    expect(resolve({ role: 'combined', pathname: '/', auth: signedOutAuth })).toEqual({
      type: 'render',
      auth: signedOutAuth,
    });
    expect(resolve({ role: 'combined', pathname: '/login' })).toEqual({
      type: 'render',
      auth: undefined,
    });
    expect(
      resolve({
        role: 'combined',
        pathname: '/lessons/vectors',
        search: '?step=2',
        auth: signedOutAuth,
      }),
    ).toEqual({
      type: 'redirect',
      to: '/login',
      search: { redirect: '/lessons/vectors?step=2' },
    });
  });
});
