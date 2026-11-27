# Aesop engine

- This package owns pure content and learning-engine rules and makes no database, HTTP, or provider calls.
- `api` owns browser-safe request and response shapes.
- `course` loads and validates curriculum from an already-resolved directory; `graph` owns prerequisite and course relationships; `memory` owns mastery and review state; `planner` owns scheduling; `lessons` owns lesson progression; `lessons/grading` owns grading algorithms; `placement` owns placement rules; `progress` owns XP, streak, and progress helpers; `store` owns the learner state interface and in-memory store.
- `memory/mastery-service.ts` writes through `LearnerStore`.
- `engine` exposes the request-scoped `createEngine` facade.
- `quizzes` owns periodic timed mixed quizzes.
- `simulator` owns learner simulations, audit invariants, and report generation.
- `cli` owns the Academy authoring and memory-simulation commands.
- Import explicit `@academy/aesop/<folder>/<module>` exports from outside this package.
- `HOW-IT-WORKS.md` explains every engine rule in Simplified Technical English and marks which rules come from Math Academy. Update it in the same change as any rule it describes.
