import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button.js';
import { Logo } from '@/components/ui/logo.js';
import { authQueryOptions } from '../auth/queries.js';
import { PUBLIC_PATHS } from './public-paths.js';

export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}

export function SkipLink() {
  return (
    <a
      className="sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:not-sr-only focus:rounded-full focus:bg-(--landing-ivory) focus:px-4 focus:py-3 focus:text-(--landing-ink) focus-visible:ring-2 focus-visible:ring-(--landing-deep)"
      href="#main-content"
    >
      Skip to content
    </a>
  );
}

export function SignInLink({
  tone,
  className = '',
}: {
  tone: 'light' | 'dark';
  className?: string;
}) {
  const { data: auth } = useQuery(authQueryOptions());
  const isPasswordless = auth?.authRequired === false;
  const toneClasses =
    tone === 'light'
      ? 'bg-(--landing-bone) text-(--landing-button-text) hover:bg-(--landing-ivory) focus-visible:border-(--landing-shell) focus-visible:ring-(--landing-bone) focus-visible:ring-offset-(--landing-deep)'
      : 'bg-(--landing-deep) text-(--landing-bone) hover:bg-(--landing-ink) focus-visible:border-(--landing-deep) focus-visible:ring-(--landing-deep) focus-visible:ring-offset-(--landing-bone)';

  return (
    <Button
      asChild
      className={`h-12 rounded-full px-6 text-base font-semibold ${toneClasses} ${className}`}
    >
      <Link to={isPasswordless ? '/' : '/login'}>
        {isPasswordless ? 'Start learning' : 'Sign in'}
      </Link>
    </Button>
  );
}

export function LandingHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const coursesActive = pathname === PUBLIC_PATHS.courses;
  const howItWorksActive = pathname === PUBLIC_PATHS.howItWorks;
  const linkClasses =
    'rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--landing-bone) focus-visible:ring-offset-2 focus-visible:ring-offset-(--landing-deep)';

  return (
    <header className="bg-(--landing-deep) text-(--landing-bone)">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-4 gap-y-4 px-6 py-5 sm:flex-nowrap sm:gap-x-5 sm:py-6 lg:gap-x-9 lg:px-20 lg:py-7">
        <Link
          to="/"
          aria-label="Open Academy home"
          className="inline-flex shrink-0 items-center gap-3 rounded-sm font-heading text-2xl font-medium tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--landing-bone) focus-visible:ring-offset-2 focus-visible:ring-offset-(--landing-deep)"
        >
          <Logo className="h-[27px] w-[30px] shrink-0" />
          <span>Open Academy</span>
        </Link>
        <nav
          aria-label="Main"
          className="order-last flex basis-full items-center gap-6 text-sm sm:order-none sm:basis-auto sm:gap-5 sm:text-base lg:gap-9"
        >
          <Link
            to={PUBLIC_PATHS.courses}
            aria-current={coursesActive ? 'page' : undefined}
            className={`${linkClasses} ${coursesActive ? 'text-(--landing-bone) underline decoration-2 underline-offset-[6px]' : 'text-(--landing-subline) hover:text-(--landing-bone)'}`}
          >
            Courses
          </Link>
          <Link
            to={PUBLIC_PATHS.howItWorks}
            aria-current={howItWorksActive ? 'page' : undefined}
            className={`${linkClasses} ${howItWorksActive ? 'text-(--landing-bone) underline decoration-2 underline-offset-[6px]' : 'text-(--landing-subline) hover:text-(--landing-bone)'}`}
          >
            How it works
          </Link>
        </nav>
        <SignInLink tone="light" className="h-10 px-[18px] text-base focus-visible:ring-offset-2" />
      </div>
    </header>
  );
}

export function LandingFinalCta() {
  return (
    <section
      aria-labelledby="start-heading"
      className="mx-auto flex max-w-[1440px] flex-col items-start gap-8 px-6 py-16 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:gap-12 lg:px-20 lg:py-24"
    >
      <div className="flex max-w-[900px] flex-col gap-3">
        <h2
          className="text-[40px] leading-[1.08] font-medium tracking-[-0.02em] text-balance sm:text-[44px] lg:text-[48px]"
          id="start-heading"
        >
          Start with vectors. Finish with LLMs.
        </h2>
        <p className="text-[18px] leading-[1.5] text-(--landing-muted) text-pretty sm:text-[19px]">
          Six courses that build on each other. Open Academy is open source, so you can also run it
          yourself.
        </p>
      </div>
      <SignInLink tone="dark" className="shrink-0 px-6" />
    </section>
  );
}

export function LandingFooter() {
  const footerLinkClasses =
    'rounded-sm text-[15px] leading-6 text-(--landing-muted) transition-colors hover:text-(--landing-deep) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--landing-deep) focus-visible:ring-offset-2 focus-visible:ring-offset-(--landing-bone)';

  return (
    <footer className="border-t border-(--landing-footer-border)">
      <div className="mx-auto flex max-w-[1440px] flex-col items-start gap-4 px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-20 lg:py-8">
        <div className="flex items-center gap-2.5 text-[15px] leading-6 text-(--landing-muted)">
          <Logo className="h-[18px] w-5 shrink-0 text-(--landing-deep)" />
          <span>© 2026 Open Academy</span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link className={footerLinkClasses} to={PUBLIC_PATHS.courses}>
            Courses
          </Link>
          <Link className={footerLinkClasses} to={PUBLIC_PATHS.howItWorks}>
            How it works
          </Link>
          <a
            className={footerLinkClasses}
            href="https://github.com/Jonathanvwersch/open-academy"
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
