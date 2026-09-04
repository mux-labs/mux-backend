# ── Stage 1: install & build ─────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma:generate
RUN pnpm run build

# ── Stage 2: production image ─────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./src/generated
COPY prisma ./prisma

# Build identity: pass --build-arg GIT_SHA=$(git rev-parse HEAD) so it's
# exposed via GET /health. Defaults to "unknown" for local/dev builds.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

EXPOSE 3000

# Copy entrypoint script that runs `prisma migrate deploy` before the app
# starts. If migrations fail the container exits non-zero so orchestrators
# (Kubernetes, ECS) can detect the failure immediately.
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main"]
