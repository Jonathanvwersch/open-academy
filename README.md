# Open Academy

Open Academy is a self-hosted learning app that teaches you a subject the way [Math Academy](https://www.mathacademy.com) teaches maths. You work through short lessons, and each one ends with a quiz. Spaced reviews bring topics back before you forget them. A placement check skips what you already know. It records which topics you've passed and how well you still remember them, and plans each day from that.

It comes with a set of courses on machine learning, AI and robotics. You can also write your own course on any subject, from scratch or from your own notes, papers and textbooks, and an AI coding agent can do most of that writing for you.

Try the demo at [open-academy-demo.vercel.app](https://open-academy-demo.vercel.app). There's no sign-in. Each browser gets a temporary learner whose progress expires after 24 hours. The tutor is off in the demo.

![The Home page](docs/images/home.png)

## How it works

- **Topics and prerequisites.** A subject is a graph of topics, and each topic lists the topics it needs first. A course is a path through that graph, split into units.
- **Placement.** The first time you start a course you can take a short adaptive placement check, or start from the beginning. Topics you place out of count as done and go straight into reviews.
- **Lessons.** A lesson is a few short steps, each with a worked example and a question or two, followed by a quiz. You pass the topic by passing the quiz.
- **Reviews.** Every topic you've learned comes back on a spaced schedule ([FSRS](https://github.com/open-spaced-repetition/ts-fsrs)). If you miss a review, the lesson opens up again.
- **Daily plan.** Each day it picks your reviews and next lessons to fit the time you set for that day.
- **Tutor (optional).** With an OpenAI API key, a tutor sits beside every lesson. It can see the question you're on and the answer key, and it never marks your work. Grading is plain code.

## How your learning is organised

Everything sits in four levels: **subject → course → unit → topic**.

```text
Mathematics   Mathematics for Machine Learning
AI            ML Foundations → Deep Learning → Transformers and LLMs → LLM Inference → Reinforcement Learning
Robotics      Classical Robotics → Robot Learning
```

- **Topics are what get unlocked.** A topic opens once every topic it needs (its hard prerequisites) is done, whichever subject those belong to. Done means you passed its lesson or the placement check showed you already know it. Soft prerequisites are background reading and never block anything.
- **Courses are never locked.** You can add any course. If its topics need topics from another course, it lists them under **Foundations** and teaches you just those topics. Each course page says up front how many topics it needs from other courses.
- **Courses in a subject go in order.** Home teaches the earliest unfinished course in each subject and starts the next one once that course has nothing left to teach. A later course can start early if the earlier one is only waiting on a prerequisite from another course.
- **Subjects share your time.** When Home picks a new topic, it goes to whichever subject you've spent the least time on recently, so time evens out across subjects and a subject with many courses doesn't crowd out one with a single course.
- **What Home picks each day.** Due reviews come first and take up to about a third of the day's time. New topics fill the rest, at most two a day, until the plan fills the time you set. You can always open any unlocked topic yourself instead.
- **Focus.** The Focus buttons on Home (All, or one subject) limit new lessons and reviews to that subject. Other subjects pause and their reviews wait until you switch back to All. Your choice is remembered.
- **Up next** lists the topics Home will teach you, in order, with roughly when, plus the date you finished each topic you've done.
- **Finish dates** come from running the same daily planner forward at your recent pace. Because all your courses share one plan, the dates take each other into account. A course without lessons yet shows "Lessons coming soon".

## Run it locally

You need Node 24, pnpm and Docker.

```sh
git clone https://github.com/Jonathanvwersch/open-academy.git
cd open-academy
pnpm bootstrap
pnpm dev
```

Open http://localhost:5173. The demo courses load by default. Set `OPENAI_API_KEY` in your environment to turn on the tutor.

## Make your own course

A course pack is a folder of YAML files: topics, lessons, questions and courses. The `academy` CLI creates one and checks it.

```sh
pnpm academy init ~/courses/organic-chemistry --title "Organic chemistry"
pnpm academy dev ~/courses/organic-chemistry
```

To write it with an agent, open the pack folder in Claude Code, Codex or a similar tool and ask for what you want: "Plan a first-year organic chemistry course and write the first unit." The pack includes an `AGENTS.md` and skills for planning a course, writing lessons and working from your own sources, and the agent runs `academy check` until everything passes.

If you have lecture notes or a textbook, add them first and the lessons will be written from them, with citations:

```sh
pnpm academy sources add ~/Downloads/week-3-notes.pdf --pack ~/courses/organic-chemistry
```

Your source files stay on your machine and aren't committed. [Writing your first course](docs/first-course.md) walks through the whole thing.

## Host it

- **Vercel and Neon:** [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FJonathanvwersch%2Fopen-academy&env=DATABASE_URL,ACADEMY_PASSWORD&envDescription=A%20Postgres%20URL%20%28Neon%20works%29%20and%20a%20sign-in%20password%20of%20at%20least%2012%20characters&envLink=https%3A%2F%2Fgithub.com%2FJonathanvwersch%2Fopen-academy%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md)
- **Your own server:** `docker compose -f deploy/docker-compose.yml up -d`

Both are covered in [Self-hosting](docs/self-hosting.md). Each instance is for one learner and is protected by a password you set (`ACADEMY_PASSWORD`).

A [public demo mode](docs/self-hosting.md#public-demo) gives each visitor temporary browser-based progress.

## Project layout

| Path                                    | What's there                                                    |
| --------------------------------------- | --------------------------------------------------------------- |
| `apps/web`                              | The React app                                                   |
| `apps/api`                              | The API: content loading, grading, mastery, scheduling, tutor   |
| `packages/cli`                          | The `academy` CLI                                               |
| `packages/contracts`, `packages/shared` | Types and helpers shared by the web app and the API             |
| `content`                               | The demo course pack (machine learning, AI and robotics)        |
| `labs`                                  | Starter code and tests for the demo pack's programming projects |

[Architecture](docs/architecture.md) and [Content format](docs/CONTENT_FORMAT.md) go into more detail.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
