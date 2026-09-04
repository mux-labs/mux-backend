#!/bin/sh
# docker-entrypoint.sh
#
# Runs Prisma migrate deploy to apply any pending migrations before starting
# the application. If migrations fail, the container exits immediately so
# orchestrators (Kubernetes, ECS, etc.) can detect the failure and restart
# rather than running against a stale schema.
#
# Usage in Dockerfile:
#   ENTRYPOINT ["/app/docker-entrypoint.sh"]
#   CMD ["node", "dist/main"]

set -e

echo "[entrypoint] Running Prisma migrate deploy..."
npx prisma migrate deploy

echo "[entrypoint] Migrations applied. Starting application..."
exec "$@"
