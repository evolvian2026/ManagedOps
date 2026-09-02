# ManagedOps

Workforce operations for a training company that recruits contract trainers and
deploys them onto client projects. One continuous lifecycle — candidate sourced,
screened, interviewed, offered, onboarded, deployed, deboarded, and returned to a
reusable talent pool.

The full specification is in [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md).
Read it before changing behaviour: it records not just what the product does but
which requirements were deliberately simplified, and why.

---

## Getting it running

**You need:** Node 22, pnpm 10, Docker (for Postgres, MinIO and Mailpit).

```bash
pnpm install
cp .env.example .env

pnpm infra:up                  # postgres, minio, mailpit
pnpm --filter @managedops/shared build
pnpm --filter @managedops/api exec prisma migrate deploy
pnpm db:seed

pnpm dev                       # api on :4000, web on :5173
```

Open http://localhost:5173. The seed prints every account it created; they all
share the password in `SEED_PASSWORD`.

| What                   | Where                          |
| ---------------------- | ------------------------------ |
| Web client             | http://localhost:5173          |
| API                    | http://localhost:4000          |
| API docs (dev only)    | http://localhost:4000/api/docs |
| Mail catcher           | http://localhost:8025          |
| Object storage console | http://localhost:9001          |

Running Postgres natively instead of in Docker works too — point `DATABASE_URL`
at it and skip `pnpm infra:up`.

---

## Layout

```
apps/
  api/         NestJS service and the scheduled-job worker
  web/         React + Vite single-page client
packages/
  shared/      Zod schemas, enums, state machines, the permission matrix
  tsconfig/    Shared TypeScript configuration
infra/
  compose/     Development and production Docker Compose
  docker/      Dockerfiles and the Caddy configuration
docs/          Specification and runbooks
```

`packages/shared` is the contract between the two applications. Enums, request
schemas, lifecycle transition tables and the RBAC matrix live there once, so the
client and the server cannot disagree about them.

---

## Commands

| Command                                    | Does                                       |
| ------------------------------------------ | ------------------------------------------ |
| `pnpm dev`                                 | Runs the API and the web client together   |
| `pnpm build`                               | Builds everything                          |
| `pnpm typecheck`                           | Typechecks every package                   |
| `pnpm test`                                | Runs every test suite                      |
| `pnpm db:seed`                             | Loads demo data (idempotent)               |
| `pnpm infra:up` / `infra:down`             | Starts or stops the local backing services |
| `pnpm --filter @managedops/api dev:worker` | Runs the scheduled-job worker              |

---

## Three things worth knowing before you change anything

**Permissions are data, not code.** `packages/shared/src/rbac.ts` holds the
capability matrix. A route declares what it needs with `@RequireCapability(...)`;
a guard consults the matrix; the test suite walks every role against every route
using that same matrix. Never check a role inline in a service — add or adjust a
capability instead, and the tests will tell you what it changed.

**Status is never assigned directly.** Every lifecycle has a transition table in
`packages/shared/src/state-machines.ts`. Services call `assertTransition(...)`,
and an illegal move becomes a 409 naming both states. This is why those tables
carry a 100% coverage requirement.

**Invariants belong in the database.** The unique index on
`(assignment_id, work_date)` is what makes "one punch-in and one punch-out per
day" unbreakable. Prefer a constraint over a check in application code whenever
the database can express the rule.

---

## Errors

Every failure is an RFC 9457 Problem Details document with a stable `type` and a
`traceId`:

```json
{
  "type": "https://managedops.app/errors/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "punchOutAt must be after punchInAt",
  "traceId": "01J8...",
  "errors": [{ "path": "punchOutAt", "message": "must be after punchInAt" }]
}
```

Unknown query parameters are rejected — but the response names the parameter and
lists what is accepted. Strict validation that will not say what it rejected is
untriageable, and the client never replaces a server message with a generic one.

---

## Build status

**Phase 0 (foundations)** — monorepo, full data model and migrations,
authentication, the permission layer, the audit trail, file storage,
notifications, the job runner, the UI shell and CI.

**Phase 1 (recruitment)** — projects and positions, candidates and applications,
screening, the interview pipeline with IST reminders and 30-day archival,
versioned offers, and the three Onboarding screens: Open Positions, Interview
Pipeline and Offer Letters.

Phases 2 to 5 add onboarding, delivery operations, exit and hardening.
`docs/SPECIFICATION.md` §16 has the plan. Screens whose module has not landed yet
say so rather than showing invented data.

| Suite                             | Count |
| --------------------------------- | ----- |
| Shared contracts                  | 109   |
| API integration (real PostgreSQL) | 136   |
| Browser (desktop + mobile)        | 37    |
