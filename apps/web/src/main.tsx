import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteLoadError } from './components/route-error.js';
import { PageSkeleton } from './components/skeletons.js';
import { routeTree } from './routeTree.gen.js';
import 'katex/contrib/copy-tex';
import './app/styles.css';

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
if (import.meta.env.DEV && import.meta.env.VITE_E2E === '1') {
  Object.assign(window, { __academyQueryClient: queryClient });
}
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 150,
  // Reveal ready content immediately instead of holding it behind a minimum loading duration.
  defaultPendingMinMs: 0,
  defaultPendingComponent: PageSkeleton,
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
