import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AcademyMascot } from '@/components/academy-mascot.js';
import courseScreenshot from './assets/landing-course.webp';
import homeScreenshot from './assets/landing-home.webp';
import lessonScreenshot from './assets/landing-lesson.webp';
import { publicCourses } from './courses-data.js';
import {
  LandingFinalCta,
  LandingFooter,
  LandingHeader,
  SignInLink,
  SkipLink,
} from './landing-chrome.js';
import { PUBLIC_PATHS } from './public-paths.js';
import './landing.css';

const features = [
  {
    title: 'A lesson',
    image: lessonScreenshot,
    alt: 'Lesson: Dot product and cosine similarity',
    description:
      'Each topic is a short lesson with a worked example for every step, then questions that are marked for you. The tutor can see what you are working on.',
  },
  {
    title: 'Your day',
    image: homeScreenshot,
    alt: "Home: today's plan with streak and next up",
    description:
      'Home plans your day: reviews of topics you are about to forget, then the next new topic.',
  },
  {
    title: 'A course',
    image: courseScreenshot,
    alt: 'Course page: Machine Learning Foundations unit 1',
    description:
      'Each topic unlocks after you pass the topics it builds on, so you always have what you need.',
  },
];

export function LandingPage() {
  useEffect(() => {
    document.title = 'Open Academy';
  }, []);

  return (
    <div className="landing min-h-screen bg-(--landing-bone) text-(--landing-ink) antialiased">
      <SkipLink />
      <LandingHeader />

      <main id="main-content">
        <section
          aria-labelledby="landing-title"
          className="overflow-x-clip bg-(--landing-deep) text-(--landing-bone)"
        >
          <div className="mx-auto grid max-w-[1440px] grid-cols-1 items-center gap-12 px-6 pb-16 pt-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)] lg:gap-[min(5.56vw,80px)] lg:px-20 lg:pb-24 lg:pt-16">
            <div className="flex flex-col items-start gap-6 lg:gap-7">
              <h1
                className="max-w-[640px] text-[48px] leading-[1.02] font-medium tracking-[-0.03em] text-balance sm:text-[64px] lg:text-[clamp(64px,6.1vw,88px)]"
                id="landing-title"
              >
                Learn AI from the maths up.
              </h1>
              <p className="max-w-[540px] text-[18px] leading-[1.5] text-(--landing-subline) text-pretty sm:text-[19px] lg:text-[21px]">
                Open Academy is an online course in AI and machine learning. Short lessons take you
                from vectors to LLMs and reinforcement learning, with an AI tutor beside every one.
              </p>
              <SignInLink tone="light" className="px-6" />
            </div>
            <div className="landing-hero-visual relative mx-auto flex aspect-square w-[min(90vw,420px)] items-center justify-center rounded-full bg-(--landing-shell) lg:w-[min(40vw,560px)]">
              <AcademyMascot decorative className="w-[82%]" />
              <div className="landing-sticker absolute -left-2 top-[4%] flex max-w-[75%] rotate-[-5deg] flex-col gap-0.5 rounded-2xl border border-(--landing-border) bg-(--landing-ivory) px-4 py-3 sm:gap-1 sm:px-5 sm:py-4 text-(--landing-ink) lg:-left-6 lg:top-[13%]">
                <span className="font-heading text-lg leading-6 font-semibold sm:text-[22px] sm:leading-7">
                  18-day streak
                </span>
                <span className="text-[13px] leading-5 text-(--landing-muted) sm:text-[15px] sm:leading-6">
                  Earn XP today to keep it going.
                </span>
              </div>
              <div className="landing-sticker absolute -right-2 bottom-[2%] flex max-w-[80%] rotate-[4deg] flex-col gap-0.5 rounded-2xl border border-(--landing-border) bg-(--landing-ivory) px-4 py-3 sm:gap-1 sm:px-5 sm:py-4 text-(--landing-ink) lg:-right-2 lg:bottom-[16%]">
                <span className="text-[13px] leading-5 font-semibold text-(--landing-muted)">
                  Review due today
                </span>
                <span className="font-heading text-base leading-5 text-balance sm:text-xl sm:leading-6">
                  Vectors, Determinants, Maximum likelihood
                </span>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="how-it-works-heading"
          className="mx-auto max-w-[1440px] px-6 pb-16 pt-16 sm:px-8 lg:px-20 lg:pb-24 lg:pt-24"
          id="how-it-works"
        >
          <div className="flex max-w-[820px] flex-col gap-3">
            <h2
              className="text-[40px] leading-[1.08] font-medium tracking-[-0.02em] text-balance sm:text-[48px] lg:text-[52px]"
              id="how-it-works-heading"
            >
              Lessons, questions, a tutor and reviews in one place.
            </h2>
            <p className="max-w-[680px] text-[18px] leading-[1.5] text-(--landing-muted) text-pretty sm:text-[19px]">
              Open Academy plans what you study each day, so you open it and start.
            </p>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-10 sm:mt-12 lg:grid-cols-3 lg:gap-6">
            {features.map((feature) => (
              <article className="flex min-w-0 flex-col gap-5" key={feature.title}>
                <div className="aspect-[41/28] overflow-hidden rounded-[20px] border border-(--landing-border) bg-(--landing-ivory)">
                  <img
                    alt={feature.alt}
                    className="h-full w-full object-cover"
                    height="560"
                    src={feature.image}
                    width="820"
                  />
                </div>
                <h3 className="font-heading text-[28px] leading-[1.2] font-medium">
                  {feature.title}
                </h3>
                <p className="text-[17px] leading-[1.55] text-(--landing-muted) text-pretty">
                  {feature.description}
                </p>
              </article>
            ))}
          </div>
          <Link
            className="mt-8 inline-flex text-base font-semibold text-(--landing-deep) underline underline-offset-4 hover:text-(--landing-ink) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--landing-deep) focus-visible:ring-offset-2"
            to={PUBLIC_PATHS.howItWorks}
          >
            See how it works
          </Link>
        </section>

        <section
          aria-labelledby="courses-heading"
          className="bg-(--landing-ivory) py-16 sm:py-20 lg:py-24"
          id="courses"
        >
          <div className="mx-auto max-w-[1440px] px-6 sm:px-8 lg:px-20">
            <h2
              className="max-w-[760px] text-[40px] leading-[1.08] font-medium tracking-[-0.02em] text-balance sm:text-[48px] lg:text-[52px]"
              id="courses-heading"
            >
              One trail, six courses. Each topic opens when you are ready for it.
            </h2>
            <ol className="landing-course-trail">
              {publicCourses.map((course, index) => (
                <li className="landing-course-step" key={course.id}>
                  <span
                    aria-hidden="true"
                    className="landing-course-marker"
                    data-first={index === 0 ? 'true' : 'false'}
                  />
                  <h3 className="font-heading text-[22px] leading-[1.22] font-medium">
                    {course.title}
                  </h3>
                </li>
              ))}
            </ol>
            <Link
              className="mt-8 inline-flex text-base font-semibold text-(--landing-deep) underline underline-offset-4 hover:text-(--landing-ink) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--landing-deep) focus-visible:ring-offset-2"
              to={PUBLIC_PATHS.courses}
            >
              See what each course covers
            </Link>
          </div>
        </section>

        <section
          aria-labelledby="reviews-heading"
          className="bg-(--landing-deep) text-(--landing-bone)"
        >
          <div className="mx-auto flex max-w-[1440px] flex-col items-start gap-8 px-6 py-16 sm:px-8 lg:flex-row lg:items-center lg:gap-12 lg:px-20 lg:py-24">
            <AcademyMascot decorative className="w-[160px] shrink-0 sm:w-[200px]" />
            <h2
              className="max-w-[960px] text-[40px] leading-[1.08] font-medium tracking-[-0.02em] text-balance sm:text-[48px] lg:max-w-[860px] lg:text-[56px]"
              id="reviews-heading"
            >
              Reviews come back just before you would forget.{' '}
              <span className="text-(--landing-tagline)">Slow, steady and hard to forget.</span>
            </h2>
          </div>
        </section>

        <LandingFinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
