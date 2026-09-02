# Rolling back a deploy

**When:** a deploy has finished and the application is worse than before —
errors, a broken screen, a failed readiness check.

**Cost:** 10 to 20 seconds of downtime. That is the accepted trade of a single
host (specification §12.5). Do not hesitate over it.

**Time:** two minutes.

## 1. Confirm the deploy is the cause

```bash
curl -sS https://managedops.example.com/ready
docker compose ps
docker compose logs --since 15m api | tail -50
```

A `ready` that returns 503 names which dependency failed. If it is the database
and no deploy went out, this is `incident-response.md`, not a rollback.

## 2. Find the previous image

Every deploy tags the image with the commit SHA, so the previous one is the
SHA before this deploy's.

```bash
grep IMAGE_TAG /opt/managedops/.env          # what is running now
docker image ls ghcr.io/<org>/managedops-api # what is still on the host
```

## 3. Roll back

```bash
sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<previous-sha>/" /opt/managedops/.env
docker compose --env-file /opt/managedops/.env up -d
```

## 4. Verify

```bash
for i in $(seq 1 30); do
  curl -sf https://managedops.example.com/ready && break
  sleep 2
done
```

Then sign in and open one screen that touches the database — Running Projects
will do. A green `/ready` with a broken page means the database is fine and the
application is not.

## 5. About the schema

**Do not roll the database back.** Migrations are forward-only and written to be
backwards-compatible with the previous release (expand/contract, §12.4), so the
older image runs against the newer schema. Reversing a migration to match an
older image is how a rollback becomes a data-loss incident.

If a migration genuinely cannot be tolerated by the previous code, that is a
released defect in the migration, not a rollback: roll forward with a fix.

## If the rollback does not help

The problem predates the deploy. Go to `incident-response.md`.
