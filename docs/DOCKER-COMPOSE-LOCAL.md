# Docker Compose Local Setup

This guide explains how to run the full mux-backend stack locally using Docker Compose — PostgreSQL + API in one command.

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| [Docker](https://docs.docker.com/get-docker/) | 24+ |
| [Docker Compose](https://docs.docker.com/compose/install/) | v2.20+ |

Node.js and pnpm are **not** required on the host; the build happens inside the container.

---

## Quick start

### 1. Copy and configure environment variables

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

| Variable | Description |
|----------|-------------|
| `WALLET_ENCRYPTION_KEY` | 32-byte hex secret for Stellar key encryption. Generate with `openssl rand -hex 32`. |
| `STELLAR_HORIZON_URL` | Horizon endpoint (`https://horizon-testnet.stellar.org` for testnet). |
| `STELLAR_NETWORK` | `TESTNET` or `PUBLIC`. |
| `WEBHOOK_SIGNING_KEY` | Master key used to derive outbound webhook signing secrets (≥32 chars, never stored/logged). Generate with `openssl rand -hex 32`. Required — the server fails to boot without it. |

> `DATABASE_URL` is **automatically overridden** by `docker-compose.yml` to point at the bundled Postgres container — you do not need to set it manually.

### 2. Start the stack

```bash
docker compose up --build
```

On first run Docker builds the API image and pulls the Postgres image. Subsequent starts reuse the cached layers and are much faster.

### 3. Run database migrations

In a separate terminal (while the stack is running):

```bash
docker compose exec api npx prisma migrate deploy
```

> **Note:** The `api` container runs as the non-root `mux` user (UID 1001). The `docker compose exec` command drops into a shell as that user, so any files created inside the container are owned by `mux`. If you need to run commands as root for debugging, use `docker compose exec --user root api sh`.

### 4. Verify the API is healthy

```bash
curl http://localhost:3000/v1/health
```

Expected response:

```json
{"status":"ok"}
```

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d` | Start in detached mode |
| `docker compose logs -f api` | Stream API logs |
| `docker compose exec api npx prisma studio` | Open Prisma Studio (DB GUI) |
| `docker compose exec api npx prisma migrate dev` | Create and apply a new migration |
| `docker compose down` | Stop and remove containers |
| `docker compose down -v` | Stop and **delete** the Postgres volume |

---

## Ports

| Service | Host port | Container port |
|---------|-----------|----------------|
| API | `3000` | `3000` |
| PostgreSQL | `5432` | `5432` |

If port `5432` conflicts with a local Postgres instance, change the host-side port in `docker-compose.yml`:

```yaml
ports:
  - '5433:5432'   # expose on host port 5433 instead
```

---

## Connecting an external client to Postgres

```
Host:     localhost
Port:     5432
User:     mux
Password: mux_secret
Database: mux_db
```

---

## Container hardening

The production Dockerfile runs the API as a non-root user (`mux`, UID 1001) with the following security controls:

| Control | Detail |
|---------|--------|
| Non-root user | The `mux` user (UID 1001) owns all application files and runs the process. |
| No new privileges | `security_opt: no-new-privileges:true` prevents the container from gaining additional capabilities at runtime. |
| Read-only filesystem (production) | The Dockerfile copies only production artifacts; the container does not include build tools, source code, or dev dependencies. |
| Fail-closed on migration failure | If `prisma migrate deploy` fails, the entrypoint exits non-zero and the container stops — orchestrators detect the failure immediately. |

For production deployments on Kubernetes or ECS, apply the same `USER` and `securityOpt` settings from `docker-compose.yml`, and consider adding a `readOnlyRootFilesystem` root-level mount with `tmpfs` for `/tmp` and Prisma cache writes.

---

## Troubleshooting

**`ECONNREFUSED` on startup** — the API starts before Postgres is ready. Docker Compose has a `healthcheck` on the `db` service and the `api` depends on it, so this should resolve automatically. If it persists, increase the `retries` value in the `db.healthcheck` block of `docker-compose.yml`.

**`relation "X" does not exist`** — migrations have not been run yet. Execute `docker compose exec api npx prisma migrate deploy`.

**Port already in use** — stop your local Postgres or change the host port mapping as described above.

**Permission denied on migration** — the `mux` user (UID 1001) must own the `/app` directory inside the container. If you rebuilt the image and see permission errors, ensure the `chown mux:mux /app` step in the Dockerfile ran successfully. You can verify with `docker compose exec api id`.
