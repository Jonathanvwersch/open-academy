import { isPublicPath, normalizePath, PUBLIC_PATHS } from './public-paths.js';

export type HostAuth = {
  authRequired: boolean;
  authenticated: boolean;
};

type RouteRedirect =
  | { type: 'redirect'; href: string; reloadDocument: true }
  | {
      type: 'redirect';
      to: '/' | '/login';
      search?: { redirect: string };
    };

export type HostRouteDecision =
  | { type: 'auth' }
  | { type: 'render'; auth: HostAuth | undefined }
  | RouteRedirect;

export function resolveHostRoute({
  role,
  pathname,
  search,
  auth,
  appUrl,
  siteUrl,
}: {
  role: 'site' | 'app' | 'combined';
  pathname: string;
  search: string;
  auth?: HostAuth;
  appUrl: (pathAndSearch: string) => string;
  siteUrl: (path: string) => string;
}): HostRouteDecision {
  const normalizedPath = normalizePath(pathname);

  if (role === 'site') {
    if (isPublicPath(pathname)) return { type: 'render', auth: undefined };
    return {
      type: 'redirect',
      href: appUrl(`${pathname}${search}`),
      reloadDocument: true,
    };
  }

  if (role === 'app' && normalizedPath === PUBLIC_PATHS.howItWorks) {
    return {
      type: 'redirect',
      href: siteUrl(PUBLIC_PATHS.howItWorks),
      reloadDocument: true,
    };
  }

  if (role === 'combined' && (normalizedPath === '/login' || normalizedPath === '/how-it-works')) {
    return { type: 'render', auth: undefined };
  }

  if (!auth) return { type: 'auth' };

  if (role === 'app' && normalizedPath === '/login') {
    return auth.authenticated ? { type: 'redirect', to: '/' } : { type: 'render', auth };
  }

  if (auth.authRequired && !auth.authenticated && (role === 'app' || !isPublicPath(pathname))) {
    if (role === 'app' && normalizedPath === '/') return { type: 'redirect', to: '/login' };
    return {
      type: 'redirect',
      to: '/login',
      search: { redirect: `${pathname}${search}` },
    };
  }

  return { type: 'render', auth };
}
