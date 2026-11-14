import { createFileRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/placement')({
  validateSearch: z.object({ id: z.string().optional(), course: z.string().optional() }),
  component: Outlet,
});
