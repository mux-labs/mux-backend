# DB Pool Sizing Guidance (#951)

How to size the Postgres connection pool for `mux-backend`, why the default can
be wrong in containers, and how to change it safely.

* Implementation: `src/prisma/database-pool.config.ts`, `src/prisma/prisma.service.ts`
* Tests: `src/prisma/database-pool.config.spec.ts`
* Related: [Docker Compose Local Setup](DOCKER-COMPOSE-LOCAL.md),
  [Backup & Restore](BACKUP_RESTORE_PROCEDURES.md)

## Why this matters

Prisma/`pg` derives its pool ceiling from the **CPU count of the host**, roughly
`cpus * 2 + 1`, unless `connection_limit` is set. In containers that is usually
wrong in both directions:

| Situation | Symptom |
|-----------|---------|
| CPU-limited container on a many-core host | Dozens of idle connections per replica; Postgres `max_connections` is exhausted once you scale out. |
| Replicas × pool > Postgres `max_connections` | `too many clients already` / connection refusals during deploys and traffic spikes. |
| Tiny pool under heavy concurrency | Requests queue behind slow queries and surface as timeouts even though the DB is healthy. |

Sizing is therefore a **per-deployment decision**, and the safest way to express
it is the pool parameters on the connection URL.

## Configuration

All variables are optional. When none are set, `DATABASE_URL` is passed through
untouched and the Prisma engine default applies — existing deployments are
unaffected.

| Variable | Maps to | Guideline |
|----------|---------|-----------|
| `DATABASE_POOL_SIZE` | `connection_limit` | Max connections this process may hold. 1–100. Start at `min(20, max_connections / replicas)`. |
| `DATABASE_POOL_TIMEOUT_SECONDS` | `pool_timeout` | How long a query waits for a free connection before failing. 1–300 s. Start at `10`. |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `connect_timeout` | TCP/TLS connect timeout. 1–300 s. Start at `5`. |

Example:

```bash
DATABASE_POOL_SIZE=20
DATABASE_POOL_TIMEOUT_SECONDS=10
DATABASE_CONNECT_TIMEOUT_SECONDS=5
```

The parameters are appended to `DATABASE_URL` at startup
(`…?schema=public&connection_limit=20&pool_timeout=10&connect_timeout=5`).

## Rules

1. **Budget against Postgres, not the app.** Keep
   `replicas × DATABASE_POOL_SIZE` below ~80 % of `max_connections` so
   migrations, admin sessions, and failover still have room.
2. **Explicit URL wins.** A parameter already present in `DATABASE_URL` is never
   overwritten. Use this to override a single environment without changing env
   vars.
3. **Fail-closed on nonsense.** A non-integer, `0`, or out-of-range value fails
   startup with an actionable error (`env.validation`), rather than silently
   falling back to an unbounded pool.
4. **Tune `pool_timeout` before enlarging the pool.** Long waits usually mean one
   slow query holding a connection; adding connections hides it and multiplies
   load. Fix the query first.
5. **Keep the pool small for money-path writes.** Every in-flight payment holds
   a connection; a pool timeout on a write is a `503` (fail-closed), never a
   partial write.

## Verifying

```bash
# What the process resolved (secret-free log line at boot):
docker compose logs api | grep 'db pool'

# Live connection count per database:
docker compose exec db psql -U mux -d mux_db \
  -c "select count(*) from pg_stat_activity where datname = 'mux_db';"

# Server ceiling:
docker compose exec db psql -U mux -d mux_db -c 'show max_connections;'
```

## Rollback

Remove the three variables (or set them back to their previous values) and
redeploy. Because configuration is opt-in and applied at startup, no migration
or schema change is involved.
