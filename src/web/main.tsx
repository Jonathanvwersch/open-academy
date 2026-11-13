import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteLoadError } from './route-error.js';
import { routeTree } from './routeTree.gen.js';
import { PageSkeleton } from './skeletons.js';
import 'katex/contrib/copy-tex';
import './styles.css';

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
  defaultPendingMs: 1_000,
  defaultPendingMinMs: 300,
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
