FROM node:24-bookworm-slim AS base

WORKDIR /app
RUN npm install --global pnpm@12.16.1

FROM base AS build

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
COPY --from=build --chown=node:node /app /app

ENV NODE_ENV=production
ENV PORT=3001
ENV CONTENT_DIR=/app/content

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["pnpm", "start"]
