import { createFileRoute } from '@tanstack/react-router';
import { HowItWorksPage } from '@/features/landing/how-it-works-page.js';

export const Route = createFileRoute('/how-it-works')({
  component: HowItWorksPage,
});
