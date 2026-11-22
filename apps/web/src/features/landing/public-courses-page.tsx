import { useEffect } from 'react';
import { publicCourses } from './courses-data.js';
import { LandingFinalCta, LandingFooter, LandingHeader, SkipLink } from './landing-chrome.js';
import './landing.css';

export function PublicCoursesPage() {
  useEffect(() => {
    document.title = 'Courses · Open Academy';
  }, []);

  return (
    <div className="landing min-h-screen bg-(--landing-bone) text-(--landing-ink) antialiased">
      <SkipLink />
      <LandingHeader />
      <main id="main-content">
        <section
          aria-labelledby="public-courses-title"
          className="bg-(--landing-deep) text-(--landing-bone)"
        >
          <div className="mx-auto max-w-[1440px] px-6 pb-16 pt-10 lg:px-20 lg:pb-20 lg:pt-16">
            <h1
              className="max-w-[900px] text-[48px] leading-[1.05] font-medium tracking-[-0.03em] text-balance lg:text-[72px]"
              id="public-courses-title"
            >
              Six courses, from vectors to LLMs
            </h1>
            <p className="mt-5 max-w-[680px] text-[18px] leading-[1.5] text-(--landing-subline) text-pretty lg:text-[20px]">
              Start with the maths, or start at Machine Learning Foundations and learn the maths as
              each model needs it. Each topic opens once you have passed the topics it builds on.
            </p>
          </div>
        </section>

        <section aria-label="Course details" className="bg-(--landing-ivory)">
          <div className="mx-auto max-w-[1440px] px-6 py-8 lg:px-20 lg:pt-8 lg:pb-16">
            {publicCourses.map((course, index) => (
              <article
                aria-labelledby={`public-course-${course.id}`}
                className={`grid grid-cols-1 gap-6 py-12 lg:grid-cols-[440px_minmax(0,1fr)] lg:gap-16 ${index < publicCourses.length - 1 ? 'border-b border-(--landing-border)' : ''}`}
                key={course.id}
              >
                <div>
                  <h2
                    className="font-heading text-[30px] leading-[1.15] font-medium text-balance lg:text-[36px]"
                    id={`public-course-${course.id}`}
                  >
                    {course.title}
                  </h2>
                  <p className="mt-4 max-w-[440px] text-[18px] leading-[1.5] text-(--landing-muted) text-pretty">
                    {course.description}
                  </p>
                </div>
                <div className="flex flex-col gap-6">
                  {course.units.map((unit) => (
                    <div key={unit.title}>
                      <h3 className="text-base leading-6 font-bold text-(--landing-ink)">
                        {unit.title}
                      </h3>
                      <p className="mt-1 text-base leading-6 text-(--landing-muted) text-pretty">
                        {unit.topics}
                      </p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <LandingFinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
