import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route = createFileRoute('/placement')({
  component: Outlet,
});
