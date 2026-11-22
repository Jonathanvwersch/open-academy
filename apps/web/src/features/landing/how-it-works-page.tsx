import { useEffect } from 'react';
import homeScreenshot from './assets/landing-home.webp';
import lessonScreenshot from './assets/landing-lesson.webp';
import placementScreenshot from './assets/landing-placement.webp';
import tutorScreenshot from './assets/landing-tutor.webp';
import { LandingFinalCta, LandingFooter, LandingHeader, SkipLink } from './landing-chrome.js';
import './landing.css';

const steps = [
  {
    title: 'Start where you are',
    description:
      'Each course opens with a short placement check. Topics you already know are marked done, and you start at the first one you need.',
    image: placementScreenshot,
    alt: 'Course page with the placement check',
  },
  {
    title: 'Learn one topic at a time',
    description:
      'A lesson has up to four short steps. Each step explains one idea, works an example line by line, then asks questions that are marked straight away.',
    image: lessonScreenshot,
    alt: 'Lesson: Dot product and cosine similarity',
  },
  {
    title: 'Ask the tutor',
    description:
      'The tutor sits beside every lesson and knows which lesson you are on. Ask it to explain a line again, give you a hint, or check your working.',
    image: tutorScreenshot,
    alt: 'Lesson with the tutor panel open',
  },
  {
    title: 'Reviews come back before you forget',
    description:
      'When you pass a topic, it returns for review a few days later, then at longer gaps. Reviews mix several topics, and passing a harder topic counts as practice for the topics under it. Home lists them each day, before your next new topic.',
    image: homeScreenshot,
    alt: "Home: today's plan with streak and next up",
  },
];

export function HowItWorksPage() {
  useEffect(() => {
    document.title = 'How it works · Open Academy';
  }, []);

  return (
    <div className="landing min-h-screen bg-(--landing-bone) text-(--landing-ink) antialiased">
      <SkipLink />
      <LandingHeader />
      <main id="main-content">
        <section
          aria-labelledby="how-it-works-title"
          className="bg-(--landing-deep) text-(--landing-bone)"
        >
          <div className="mx-auto max-w-[1440px] px-6 pb-16 pt-10 lg:px-20 lg:pb-20 lg:pt-16">
            <h1
              className="max-w-[900px] text-[48px] leading-[1.05] font-medium tracking-[-0.03em] text-balance lg:text-[72px]"
              id="how-it-works-title"
            >
              How Open Academy works
            </h1>
            <p className="mt-5 max-w-[640px] text-[18px] leading-[1.5] text-(--landing-subline) text-pretty lg:text-[20px]">
              Each day you open it, Open Academy tells you what to do next: the reviews that are
              due, then one new topic. Here is what each part does.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-[1440px] px-6 lg:px-20">
          {steps.map((step, index) => (
            <section
              aria-labelledby={`how-step-${index + 1}`}
              className={`flex flex-col gap-8 py-16 lg:items-center lg:justify-between ${index % 2 === 1 ? 'lg:flex-row-reverse' : 'lg:flex-row'}`}
              key={step.title}
            >
              <div className="w-full lg:max-w-[480px]">
                <h2
                  className="text-[32px] leading-[1.12] font-medium tracking-[-0.02em] text-balance lg:text-[40px]"
                  id={`how-step-${index + 1}`}
                >
                  {step.title}
                </h2>
                <p className="mt-4 max-w-[480px] text-[18px] leading-[1.5] text-(--landing-muted) text-pretty">
                  {step.description}
                </p>
              </div>
              <div className="aspect-[820/560] w-full overflow-hidden rounded-2xl border border-(--landing-border) bg-(--landing-ivory) lg:max-w-[720px]">
                <img
                  alt={step.alt}
                  className="h-full w-full object-cover object-top"
                  height="560"
                  loading="lazy"
                  src={step.image}
                  width="820"
                />
              </div>
            </section>
          ))}
        </div>

        <LandingFinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
