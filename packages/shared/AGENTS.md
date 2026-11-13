# Shared behavior

- Keep small deterministic helpers with actual frontend/backend consumers here, with unit tests.
- Import no application, database, filesystem, provider SDK or UI runtime. Feature-specific logic stays with its feature.
- Add an explicit package subpath export for each public module; do not add a root barrel.
