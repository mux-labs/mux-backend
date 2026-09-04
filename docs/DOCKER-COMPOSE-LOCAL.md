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

## Troubleshooting

**`ECONNREFUSED` on startup** — the API starts before Postgres is ready. Docker Compose has a `healthcheck` on the `db` service and the `api` depends on it, so this should resolve automatically. If it persists, increase the `retries` value in the `db.healthcheck` block of `docker-compose.yml`.

**`relation "X" does not exist`** — migrations have not been run yet. Execute `docker compose exec api npx prisma migrate deploy`.

**Port already in use** — stop your local Postgres or change the host port mapping as described above.
