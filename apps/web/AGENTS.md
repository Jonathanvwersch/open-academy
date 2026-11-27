# Learner web app

- React, Vite, TanStack Router/Query, Tailwind and shadcn/Radix. Keep existing libraries and UI behavior unless the task asks for a change.
- `src/routes` defines URLs, search validation, loaders and route-level pending/error UI. Put pages and behavior in `src/features/<feature>`; use `getRouteApi` for typed route hooks without importing route source.
- `src/app` owns providers and the shell. `src/components/ui` owns generic primitives; `src/components`, `src/api`, `src/lib` and `src/hooks` remain independent of features.
- Each feature owns query factories, mutations, components and tests. `features/lessons` is the working example. Share narrow public modules, not a barrel exposing all internals.
- API response types come from `@academy/aesop/api/*`; shared helpers from `@academy/shared/*`. Never import API source, even types.
- Keep unit tests beside code. Cross-app tests/fixtures live at the root. `src/routeTree.gen.ts` is generated; do not edit it by hand.
- From the root run `pnpm check`, `pnpm test:unit`, and relevant `pnpm test:e2e` cases. `pnpm dev:web` starts Vite; `pnpm build` verifies bundled assets.

- UI copy must serve an action, state, or learning content. Do not add slogans, decorative eyebrow labels, uppercase section captions, or visible page titles that repeat the navigation. Preserve accessible headings without adding visible clutter.
- Use shared card and control primitives for spacing, radii, focus, loading, and disabled states. Review real desktop and mobile screenshots, including long text and pending/error states; passing tests alone does not establish visual quality.
- Keep diagnostic actions distinct: “I don’t know” records only the current question as unknown; “Skip topic” ends assessment of that topic. Do not disguise one as the other.
- Page loading skeletons use captured layout geometry from the rendered view, keyed by URL, content width, breakpoint, and build. Do not reintroduce separately designed placeholder pages. Before a layout is known, show the shared loading indicator. Store geometry only, never text, answers, or HTML.
