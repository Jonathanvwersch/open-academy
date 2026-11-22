export const PUBLIC_PATHS = {
  home: '/',
  courses: '/courses',
  howItWorks: '/how-it-works',
} as const;

export function normalizePath(pathname: string) {
  return pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

export function isPublicPath(pathname: string) {
  const normalizedPath = normalizePath(pathname);
  return Object.values(PUBLIC_PATHS).some((path) => path === normalizedPath);
}
