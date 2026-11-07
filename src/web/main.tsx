import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteLoadError } from './route-error.js';
import { routeTree } from './routeTree.gen.js';
import './styles.css';

function RoutePendingSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-6">
      <div className="h-4 w-32 rounded bg-neutral-200" />
      <div className="h-9 w-56 rounded bg-neutral-200" />
      <div className="h-36 w-full rounded-xl bg-neutral-200" />
    </div>
  );
}

function DefaultRouteError() {
  return (
    <RouteLoadError
      message="This page couldn't load."
      className="text-sm text-red-700"
      role="alert"
    />
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 3_500,
  defaultPendingMinMs: 300,
  defaultPendingComponent: RoutePendingSkeleton,
  defaultErrorComponent: DefaultRouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
