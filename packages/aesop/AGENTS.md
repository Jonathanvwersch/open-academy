# Aesop engine

- This package owns pure content and learning-engine rules and makes no database, HTTP, or provider calls.
- `course` loads and validates curriculum from an already-resolved directory; `graph` owns prerequisite and course relationships; `memory` owns mastery and review state; `planner` owns scheduling; `lessons` owns lesson progression; `lessons/grading` owns grading algorithms; `placement` owns placement rules; `progress` owns XP, streak, and progress helpers.
- Import explicit `@academy/aesop/<folder>/<module>` exports from outside this package.
