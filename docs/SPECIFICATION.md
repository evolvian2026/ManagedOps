# ManagedOps — Build-Ready Specification

**Version:** 1.0 (draft for approval)
**Status:** Awaiting sign-off. No implementation has started.
**Repository:** `evolvian2026/ManagedOps`

---

## 1. Overall Application Scope

### 1.1 What ManagedOps is

ManagedOps is an internal workforce operations platform for a training services company that
recruits contract trainers and deploys them onto client projects running roughly one academic
term (3–4 months) each.

It manages one continuous lifecycle:

```
Candidate sourced  →  Screened  →  Interviewed  →  Offered  →  Onboarded
      ↑                                                            ↓
      └──────────────  Talent Pool  ←──  Deboarded  ←──  Active on project
```

Every stage that today lives in spreadsheets, WhatsApp threads and inboxes becomes a record with
an owner, a status, an audit trail and a next action.

### 1.2 In scope for v1

| Area        | Included                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Recruitment | Positions, candidates, applications, screening, interviews, offers                                           |
| Onboarding  | Credential issue, forced password change, document collection & verification, project assignment             |
| Delivery    | Attendance (GPS-stamped), daily teaching log, deliverables, leave, assets, reimbursements, performance flags |
| Exit        | Deboarding checklist, asset return, full & final settlement, exit feedback, re-hire eligibility              |
| Reuse       | Talent Pool spanning rejected candidates, declined offers and former trainers                                |
| Platform    | RBAC, audit log, notifications (in-app + email), file storage, scheduled jobs, reporting exports             |

### 1.3 Explicitly out of scope for v1

- Public "apply here" careers page (data model is ready for it; no public surface built)
- Payroll processing, invoicing, or accounting integration
- Mailbox provisioning (Google Workspace / M365) — work email is recorded, not created
- Offer-letter PDF generation
- Mobile native apps (the web UI is responsive and works on a phone)
- Google/GitHub SSO (deferred — see §14.3)
- Multi-tenancy (single organisation)

### 1.4 Scale targets

| Dimension                 | Target                                      |
| ------------------------- | ------------------------------------------- |
| Trainers under management | 300 active, 2,000 lifetime records          |
| Concurrent admin users    | 25                                          |
| Concurrent trainer users  | 300 (attendance punch spikes at ~09:00 IST) |
| Projects                  | 50 concurrent                               |
| Documents stored          | ~15,000 files, ~30 GB                       |
| Peak request rate         | ~50 req/s                                   |

This is a **small-data, workflow-heavy** system. Correctness, auditability and clarity matter far
more than horizontal scale, and the architecture reflects that.

---

## 2. Key Features and Functionality

### 2.1 Recruitment

- **Positions** — created against a project with a headcount target; auto-closes when filled.
- **Candidates & applications** — a candidate is a _person_ (created once, reusable forever); an
  application is that person applied to one position. This separation is what makes the Talent
  Pool genuinely reusable.
- **Screening** — HR records the call outcome: _proceed to interview_, _not available_, or
  _reject_. Outcome drives routing automatically.
- **Interviews** — scheduled with a meeting link, date/time (IST), and an assigned interviewer.
  Automatic reminders. Missed interviews stay visible until rescheduled; rescheduling creates a
  linked follow-up round so the history survives.
- **Offers** — versioned. A revision creates version 2, not an overwrite. Status tracked through
  to acceptance; the actual letter is sent out of band and optionally attached.

### 2.2 Onboarding

- Accepted offer → one-click conversion to a Trainer record with a login account.
- Temporary password emailed to the candidate's **personal** email; forced change on first login.
- Document checklist (Aadhaar, PAN, education certificate, experience certificate, photo) with
  upload, HR verification, and reminder escalation.
- Assignment to a project with a role (Trainer or Project Lead), start date, and leave allowance.

### 2.3 Delivery operations

- **Attendance** — one punch-in and one punch-out per assignment per day, each capturing GPS
  coordinates and a server timestamp. Late marking with a configurable grace period. Correction
  requests when a punch is missed.
- **Daily log** — per day, per teaching session: topic, hours, notes. Locked on submission;
  changes require an admin unlock (audited).
- **Deliverables** — syllabus items and other duties as a checklist with optional file attachments.
- **Leave** — request with half-day support, balance tracking, single-approver flow with
  time-based escalation.
- **Assets** — hardware and accessories issued against a serial number and reconciled on return;
  digital resources (work email) recorded without a serial.
- **Reimbursements** — submitted with a proof file; two-tier approval by amount.
- **Flags** — a Project Lead raises a concern against a trainer; the project's Manager and HR are
  notified and record the action taken.

### 2.4 Exit

- Deboarding checklist per assignment: last working day, asset return reconciliation, travel,
  full & final settlement, exit feedback, re-hire eligibility.
- Completing deboarding returns the trainer to the Talent Pool if marked re-hire eligible.

### 2.5 Platform

- Full audit log of every mutation, with before/after payloads, filterable and CSV-exportable.
- In-app notification centre plus transactional email.
- Dashboard summaries per role.
- CSV export on every major list.

---

## 3. User Roles and Permissions

### 3.1 Roles

| Role             | Scope                    | Purpose                                                                        |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------ |
| **Super Admin**  | Global                   | User & role management, system settings, full audit access                     |
| **Manager**      | Global                   | Owns projects and staffing; approves escalations and high-value reimbursements |
| **HR**           | Global                   | Candidate intake, screening, offers, onboarding, documents, reimbursements     |
| **Interviewer**  | Assigned interviews only | Records interview outcome and feedback                                         |
| **Project Lead** | Own project(s)           | Read-only oversight of their team; raises flags; first-line leave approver     |
| **Trainer**      | Own records only         | Self-service                                                                   |

### 3.2 Permission matrix

Legend: **F** full (create/read/update/delete) · **W** create+read+update · **R** read ·
**O** own records only · **P** own project(s) only · **—** no access

| Capability                         | Super Admin | Manager | HR  | Interviewer       | Project Lead | Trainer |
| ---------------------------------- | ----------- | ------- | --- | ----------------- | ------------ | ------- |
| Users & roles                      | F           | —       | —   | —                 | —            | —       |
| System settings                    | F           | R       | R   | —                 | —            | —       |
| Audit log                          | F           | R       | R   | —                 | —            | —       |
| Projects                           | F           | F       | R   | —                 | R (P)        | —       |
| Positions                          | F           | F       | W   | —                 | R (P)        | —       |
| Candidates & applications          | F           | F       | F   | R (assigned only) | —            | —       |
| Screening decision                 | F           | W       | W   | —                 | —            | —       |
| Interviews — schedule              | F           | W       | W   | —                 | —            | —       |
| Interviews — record outcome        | F           | W       | W   | W (assigned)      | —            | —       |
| Offers                             | F           | F       | F   | —                 | —            | —       |
| Trainer profile (non-sensitive)    | F           | F       | F   | —                 | R (P)        | R (O)   |
| Trainer salary                     | F           | F       | F   | —                 | —            | R (O)   |
| Trainer ID documents               | F           | R       | F   | —                 | —            | W (O)   |
| Assignments                        | F           | F       | W   | —                 | R (P)        | R (O)   |
| Attendance records                 | F           | F       | F   | —                 | R (P)        | W (O)   |
| Attendance corrections — approve   | F           | W       | W   | —                 | W (P)        | —       |
| Daily log                          | F           | R       | R   | —                 | R (P)        | W (O)   |
| Deliverables                       | F           | W       | W   | —                 | W (P)        | W (O)   |
| Leave — request                    | —           | —       | —   | —                 | —            | W (O)   |
| Leave — approve                    | F           | W       | W   | —                 | W (P)        | —       |
| Assets                             | F           | F       | F   | —                 | R (P)        | R (O)   |
| Reimbursements — submit            | —           | —       | —   | —                 | —            | W (O)   |
| Reimbursements — approve ≤ ₹10,000 | F           | W       | W   | —                 | —            | —       |
| Reimbursements — approve > ₹10,000 | F           | W       | —   | —                 | —            | —       |
| Flags — raise                      | F           | W       | W   | —                 | W (P)        | —       |
| Flags — resolve                    | F           | W       | W   | —                 | —            | —       |
| Deboarding                         | F           | F       | W   | —                 | R (P)        | R (O)   |
| Talent Pool                        | F           | F       | F   | —                 | —            | —       |

### 3.3 Sensitive-data rules

- **Aadhaar and PAN numbers are never stored in plaintext.** Only the uploaded document file and
  the last four characters are persisted, for identification.
- Every download of an identity document or salary field writes an audit entry naming the actor.
- Interviewers see the candidate's name, contact, resume and application history — never salary,
  identity documents, or project financials.
- Project Leads see attendance, deliverables and daily logs for their team — never salary or
  identity documents.

### 3.4 Enforcement model

Three layers, all required:

1. **Route guard** — role must be in the endpoint's allow-list.
2. **Policy check** — resource-level rule (e.g. "Project Lead may approve leave only for an
   assignment on a project they lead").
3. **Query scoping** — the data layer injects an ownership predicate for scoped roles, so a
   scoped user physically cannot read rows outside their scope even if a guard is misconfigured.

---

## 4. Application Workflows / User Journeys

### 4.1 Candidate lifecycle

Candidate status (the _person_):

```
active ──────────► hired
   │                 │
   └──► archived ◄───┘ (after deboarding, if not re-hire eligible)
```

Application status (the _person applied to a position_) — the state machine that actually drives work:

```
                    ┌──► rejected_screening ──┐
                    │                          │
applied ──► screening ──► interviewing ──► offer_stage ──► hired
                    │           │                │
                    │           └──► rejected_interview ──┐
                    │                                      ├──► (pool eligible)
                    └──► not_available ────────────────────┤
                                                            │
                                offer_declined ─────────────┘

any state ──► withdrawn   (candidate pulled out)
```

**Rules**

- Screening outcome _proceed_ → `interviewing`. _Not available_ → `not_available`, pool eligible.
  _Reject_ → `rejected_screening`, pool eligible with reason recorded.
- A candidate may hold several applications over time; only one may be `hired` at a time.
- `pool_eligible` defaults to true for every terminal non-hired state and can be turned off by HR.

### 4.2 Interview lifecycle

```
scheduled ──► completed ──► outcome: selected | rejected
    │
    ├──► missed ──► (admin reschedules) ──► new interview round, linked to this one
    │                   │
    │                   └── after 30 days unactioned ──► archived (never deleted)
    │
    └──► cancelled
```

**Rules**

- All times stored UTC, displayed and entered in **IST (Asia/Kolkata)**.
- Reminders to candidate and interviewer: **09:00 IST on the interview day** and **30 minutes before**.
- "To be scheduled" is not a stored state — it is the derived set of applications in
  `interviewing` with no open interview round.
- Selecting a candidate moves the application to `offer_stage` and creates a draft offer.

### 4.3 Offer lifecycle

```
draft ──► sent ──► accepted ──► (converted to trainer)
            │
            ├──► declined            → application: offer_declined, pool eligible
            ├──► revision_requested  → new offer version (draft) linked to this one
            └──► withdrawn
```

Every revision is a new row with an incremented `version`. History is the full row set — there is
no separate "previous records" store.

### 4.4 Trainer onboarding

1. HR clicks **Convert to Trainer** on an accepted offer.
2. System creates a `User` (role `trainer`, `must_change_password = true`) and a `Trainer` record
   linked back to the candidate, generates a 16-character temporary password, and emails it to the
   personal email address. The password is never displayed in the UI or written to logs.
3. Trainer logs in → forced password change screen → cannot navigate elsewhere until changed.
4. Trainer sees a document checklist. Reminders fire at **24 h** and **72 h**; at 72 h the
   onboarding HR is notified. Access is **not** blocked (see §15.7).
5. HR verifies each document; when all mandatory documents are verified and an assignment exists,
   the trainer's status becomes `active`.

Trainer status (lifecycle only — not attendance, not flags):

```
pending_onboarding ──► active ──► deboarding ──► deboarded ──► archived
```

### 4.5 Attendance

```
(no record) ──► punch_in ──► present | late   ──► punch_out ──► complete
                                  │
                                  └── no punch_out by 23:59 IST ──► missing_punch_out
                                                                          │
                                          trainer raises correction ──► correction_pending
                                                                          │
                                                              approver ──► corrected | rejected
```

Non-punch day statuses, set by the system or an approved leave: `absent`, `on_leave`,
`half_day`, `leave_without_pay`, `holiday`, `weekly_off`.

**Rules**

- A unique database constraint on `(assignment_id, work_date)` makes duplicate punch-in or
  punch-out structurally impossible, not merely validated against.
- **Grace period: 15 minutes** after the project's configured start time. Rationale: trainers
  commute to client sites where entry queues and traffic routinely cost 5–10 minutes; a 15-minute
  buffer absorbs ordinary variance while still surfacing genuine lateness. Configurable per project.
- GPS coordinates are captured for record-keeping. **No geofencing.** If the browser denies
  location the punch still succeeds and is marked `location_unavailable`.
- A consent notice is shown before the first punch and the acceptance is recorded.

### 4.6 Leave

```
submitted ──► approved ──► (attendance days written as on_leave / half_day)
    │
    ├──► rejected
    ├──► cancelled (by trainer, before start date)
    └──► escalated (no decision within 24 h) ──► approved | rejected by Manager or HR
```

**Rules**

- Allowance: **3 full-day equivalents per assignment.** A half-day consumes 0.5.
- Requests exceeding the balance may still be submitted; the approver sees the overage and, if
  approved, the excess days are recorded as `leave_without_pay`.
- Weekends and configured holidays inside a leave range do not consume balance.
- **First approver is the Project Lead.** If undecided after 24 hours it escalates to the project's
  Manager and HR, either of whom may decide. Any single approval is sufficient. (Simplification —
  see §15.4.)
- Balance is per assignment and does not carry over between projects.

### 4.7 Reimbursement

```
submitted ──► under_review ──► approved ──► reimbursed
                   │
                   └──► rejected (reason required)
```

Routed to the **project's assigned HR**. Amounts up to **₹10,000** are approved by HR; above that,
Manager approval is required. Proof file is mandatory.

### 4.8 Asset

```
issued (serial recorded) ──► returned (serial verified against issue) ──► archived
                    │
                    └──► lost | damaged  (recorded on the issue, blocks deboarding completion)
```

### 4.9 Flag

```
raised ──► acknowledged ──► action_taken (warning | LWP | penalty | removal | none) ──► closed
```

Raised by the Project Lead against an assignment. The project's Manager and HR are notified
automatically. (Simplification — see §15.5.)

### 4.10 Deboarding

```
initiated ──► assets_pending ──► fnf_pending ──► completed
```

Completion requires every issued asset reconciled and the F&F settlement marked settled or waived.
On completion the trainer becomes `deboarded` and, if `rehire_eligible`, appears in the Talent Pool.

### 4.11 Talent Pool

Not a table — a unified query over two sources:

- Candidates with a terminal application state and `pool_eligible = true`
- Deboarded trainers with `rehire_eligible = true`

Each entry carries: name, contact, email, last position, last project, last status, reason,
whether they have worked with us before, and their resume. Searchable and filterable; an entry can
be pushed straight into a new application on an open position.

---

## 5. Recommended Technology Stack

### 5.1 Choices

| Layer            | Choice                                                            | Why                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language         | **TypeScript 5.x** everywhere                                     | One language, shared types across the wire                                                                                                                                           |
| Runtime          | **Node.js 22 LTS**                                                | Current LTS through 2027                                                                                                                                                             |
| Backend          | **NestJS 11**                                                     | Module system maps 1:1 onto bounded contexts; DI makes the policy/audit layers testable; guards and pipes give a clean place for RBAC and validation; first-class OpenAPI generation |
| ORM              | **Prisma 6**                                                      | Typed client generated from schema, first-class migrations, explicit relations — removes the whole class of untyped-reference bugs                                                   |
| Database         | **PostgreSQL 16**                                                 | See §5.2                                                                                                                                                                             |
| Frontend         | **React 19 + Vite 6**                                             | Fast, well-understood, large hiring pool                                                                                                                                             |
| Routing / data   | **React Router 7** + **TanStack Query 5**                         | Query gives caching, retries and per-request loading/error states for free — the states the spec demands                                                                             |
| Forms            | **React Hook Form + Zod**                                         | The same Zod schemas the API validates with                                                                                                                                          |
| Styling          | **Tailwind CSS 4** + **shadcn/ui** (Radix primitives)             | Accessible-by-default components; no bespoke component library to maintain                                                                                                           |
| Shared contracts | `packages/shared` — Zod schemas, enums, state-machine definitions | Single source of truth; the API/UI contract drift that plagues split codebases is eliminated                                                                                         |
| Background jobs  | **pg-boss**                                                       | A durable job queue _inside PostgreSQL_ — reminders, escalations, archival, all with retries and dead-lettering, with **no Redis to run**                                            |
| Auth             | JWT access token + rotating refresh token in an httpOnly cookie   | See §10                                                                                                                                                                              |
| Password hashing | **Argon2id**                                                      | OWASP's current first choice; memory-hard, unlike bcrypt                                                                                                                             |
| Files            | **S3** (AWS) / **MinIO** (local) via presigned URLs               | Uploads never transit the API                                                                                                                                                        |
| Email            | **AWS SES** (prod) / **Mailpit** (local)                          | Behind a transport interface                                                                                                                                                         |
| Logging          | **Pino** structured JSON + request IDs                            | Machine-parseable, cheap                                                                                                                                                             |
| API docs         | **OpenAPI 3.1** via Nest Swagger                                  | Generated from the code, cannot drift                                                                                                                                                |
| Testing          | **Vitest** + **Supertest** + **Testcontainers** + **Playwright**  | Unit, integration against a real Postgres, and E2E                                                                                                                                   |
| Containers       | **Docker** multi-stage, distroless-ish, non-root                  |                                                                                                                                                                                      |
| CI/CD            | **GitHub Actions** → GHCR → SSH deploy                            |                                                                                                                                                                                      |
| IaC              | **Terraform**                                                     | Declarative, reviewable AWS state                                                                                                                                                    |
| Monorepo         | **pnpm workspaces**                                               | Two apps and two packages need workspaces, not a build orchestrator                                                                                                                  |

### 5.2 PostgreSQL over MongoDB — the most significant deviation

The reference documents specify MongoDB. **This specification uses PostgreSQL**, for reasons the
domain makes unusually clear-cut:

- **The domain is relational.** Candidate → application → interview → offer → trainer →
  assignment → attendance is a chain of foreign keys. Modelling it in a document store means
  either duplicating data across documents (and re-synchronising it forever) or reimplementing
  joins in application code.
- **Invariants belong in the database.** `UNIQUE (assignment_id, work_date)` on attendance makes
  the duplicate-punch requirement structurally unbreakable. A leave balance decrement and the
  attendance rows it writes belong in one transaction. Referential integrity means an assignment
  cannot point at a deleted project.
- **The reporting surface is aggregate-heavy.** "Attendance percentage per project this month",
  "open positions with applicant counts", "pending reimbursements by approver" are one SQL query
  each and awkward pipelines otherwise.
- **Data volume is small.** ~30 GB of files in S3 and well under 10 GB of relational data. No
  scale argument favours a document store here.
- **Prisma's generated types remove an entire bug class** — the `_id`/`id` mismatch and silently
  untyped ObjectId references that broke multiple screens in the prior attempt are not expressible.

Trade-off accepted: schema changes require migrations. For a domain this stable and this
constraint-heavy, that is a feature.

### 5.3 Repository layout

```
ManagedOps/
├── apps/
│   ├── api/                     NestJS service
│   │   ├── prisma/              schema.prisma, migrations/, seed.ts
│   │   ├── src/
│   │   │   ├── common/          guards, interceptors, filters, decorators, pagination
│   │   │   ├── modules/         one folder per bounded context (§6.2)
│   │   │   ├── jobs/            pg-boss workers
│   │   │   └── main.ts
│   │   └── test/                integration + e2e specs
│   └── web/                     React + Vite SPA
│       └── src/
│           ├── app/             router, providers, error boundaries
│           ├── features/        one folder per domain area
│           ├── components/ui/   shared primitives
│           └── lib/             api client, auth, formatting
├── packages/
│   ├── shared/                  Zod schemas, enums, state machines, permission matrix
│   └── tsconfig/                base TS configs
├── infra/
│   ├── compose/                 docker-compose.dev.yml, docker-compose.prod.yml
│   ├── docker/                  Dockerfiles, Caddyfile
│   └── terraform/               AWS resources
├── docs/                        this spec, ADRs, runbooks
└── .github/workflows/
```

---

## 6. System Architecture

### 6.1 Shape

A **modular monolith**: one deployable API process plus one worker process, internally divided
into modules with explicit boundaries. Modules communicate through injected service interfaces and
domain events, never by reaching into each other's tables.

For 300 trainers and 25 admins, microservices would add network failure modes, distributed
transactions and deployment complexity in exchange for scaling headroom the system will never use.
The module boundaries are drawn so extraction stays _possible_, but extraction is explicitly not a
v1 deliverable. (See §15.9.)

### 6.2 Modules

| Module          | Owns                                                         |
| --------------- | ------------------------------------------------------------ |
| `identity`      | Users, sessions, password lifecycle, RBAC policies           |
| `audit`         | Audit log capture and query                                  |
| `files`         | Presigned upload/download, metadata, retention               |
| `notifications` | In-app notifications, email dispatch, templates              |
| `projects`      | Projects, positions, holidays, project settings              |
| `recruitment`   | Candidates, applications, screening, interviews, offers      |
| `workforce`     | Trainers, documents, assignments, deboarding                 |
| `attendance`    | Attendance records, corrections, leave requests and balances |
| `operations`    | Daily logs, deliverables, assets, reimbursements, flags      |
| `pool`          | Talent Pool read model                                       |
| `reporting`     | Dashboard summaries, CSV exports                             |

Cross-cutting concerns (`common/`) are implemented once as NestJS primitives:

- `JwtAuthGuard` → `RolesGuard` → `PolicyGuard` pipeline on every protected route
- `AuditInterceptor` — writes an audit entry for every non-GET request that mutates state
- `ZodValidationPipe` — validates body, query and params against the shared schemas
- `ProblemDetailsFilter` — converts every thrown error into RFC 9457 JSON
- `PaginationPipe` — parses and bounds `page`, `pageSize`, `sort`, `q`

### 6.3 Containers

```
                       ┌──────────────────────────┐
   Browser (SPA) ──────►  Caddy (TLS, static SPA, │
                       │  reverse proxy /api)     │
                       └───────────┬──────────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │  api        (NestJS HTTP) │
                     │  worker     (pg-boss)     │
                     └──┬──────────┬─────────┬───┘
                        │          │         │
                ┌───────▼──┐  ┌────▼───┐  ┌──▼─────┐
                │ Postgres │  │   S3   │  │  SES   │
                │  (RDS)   │  │ bucket │  │ email  │
                └──────────┘  └────────┘  └────────┘
```

The API and worker are the **same image** with a different entrypoint, so they can never drift.

### 6.4 Scheduled jobs (worker)

| Job                           | Schedule (IST) | Does                                                                             |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `interview.reminder.daily`    | 09:00 daily    | Notifies candidate + interviewer of today's interviews                           |
| `interview.reminder.imminent` | every 5 min    | Notifies for interviews starting in 30–35 minutes                                |
| `interview.archive.stale`     | 02:00 daily    | Archives interviews missed > 30 days                                             |
| `attendance.close.day`        | 23:55 daily    | Marks `missing_punch_out`; writes `absent` for active assignments with no record |
| `onboarding.document.remind`  | 10:00 daily    | 24 h / 72 h document reminders, escalates at 72 h                                |
| `leave.escalate`              | hourly         | Escalates leave requests undecided for 24 h                                      |
| `files.cleanup.orphans`       | 03:00 weekly   | Deletes uploads never attached to a record                                       |

Every job is idempotent and keyed so a re-run cannot double-send.

---

## 7. Data Model

### 7.1 Conventions applied to every table

- `id` — UUID v7 (time-sortable, no sequence contention, safe to expose)
- `created_at`, `updated_at` — `timestamptz`, always UTC
- `created_by_id`, `updated_by_id` — FK to `users`
- Soft delete on business records: `deleted_at`, `deleted_by_id`; Prisma middleware appends
  `deleted_at IS NULL` to every read unless explicitly overridden
- Hard delete only for: refresh tokens, notifications older than 90 days, orphaned file uploads

### 7.2 Entities

**Identity & platform**

| Table            | Key fields                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `users`          | email (unique, citext), password_hash, role, status, must_change_password, name, phone, last_login_at, failed_login_count, locked_until |
| `refresh_tokens` | user_id, token_hash, expires_at, revoked_at, replaced_by_id, ip, user_agent                                                             |
| `audit_logs`     | actor_user_id, action, entity_type, entity_id, before (jsonb), after (jsonb), ip, user_agent, created_at                                |
| `files`          | storage_key, original_name, mime_type, size_bytes, checksum_sha256, owner_type, owner_id, uploaded_by_id, scan_status                   |
| `notifications`  | user_id, type, title, body, entity_type, entity_id, read_at                                                                             |
| `app_settings`   | key (pk), value (jsonb), updated_by_id                                                                                                  |

**Projects**

| Table       | Key fields                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`  | name, code (unique), client_name, location, start_date, end_date, status, manager_id, hr_id, lead_trainer_id, work_start_time, grace_minutes |
| `positions` | project_id, title, headcount, filled_count, description, status, closed_at                                                                   |
| `holidays`  | project_id (nullable = org-wide), date, name — unique (project_id, date)                                                                     |

**Recruitment**

| Table          | Key fields                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidates`   | name, email (unique), phone, linkedin_url, source, resume_file_id, status, pool_eligible, worked_before, notes                                                   |
| `applications` | candidate_id, position_id, status, screening_outcome, screening_notes, screened_by_id, screened_at, rejection_reason — unique (candidate_id, position_id)        |
| `interviews`   | application_id, round, scheduled_at, duration_minutes, meeting_url, interviewer_id, status, outcome, feedback, recording_url, previous_interview_id, archived_at |
| `offers`       | application_id, version, salary_annual, joining_date, status, sent_at, responded_at, notes, attachment_file_id — unique (application_id, version)                |

**Workforce**

| Table               | Key fields                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trainers`          | user_id (unique), candidate_id, employee_code (unique), personal_email, work_email, phone, joining_date, salary_annual, status, onboarding_hr_id, rehire_eligible  |
| `trainer_documents` | trainer_id, doc_type, file_id, last_four, status (pending/verified/rejected), verified_by_id, verified_at, reject_reason — unique (trainer_id, doc_type)           |
| `assignments`       | trainer_id, project_id, role (trainer/lead), start_date, end_date, status, leave_allowance_days — partial unique (trainer_id, project_id) where status = 'active'  |
| `deboardings`       | assignment_id (unique), initiated_by_id, last_working_day, reason, assets_reconciled, travel_notes, fnf_status, fnf_amount, fnf_settled_at, feedback, completed_at |

**Attendance & leave**

| Table                    | Key fields                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attendance_records`     | assignment_id, work_date, punch_in_at, punch_in_lat, punch_in_lng, punch_out_at, punch_out_lat, punch_out_lng, status, location_status, source — **unique (assignment_id, work_date)** |
| `attendance_corrections` | attendance_record_id, requested_by_id, requested_punch_in, requested_punch_out, reason, status, reviewed_by_id, reviewed_at, review_note                                               |
| `leave_requests`         | assignment_id, start_date, end_date, day_type, days_count, reason, status, approver_id, decided_at, decision_note, escalated_at                                                        |

**Operations**

| Table            | Key fields                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `daily_logs`     | assignment_id, work_date, session_no, topic, hours, notes, submitted_at, locked — unique (assignment_id, work_date, session_no)    |
| `deliverables`   | assignment_id, type (syllabus/other_duty), title, description, due_date, status, file_id, completed_at                             |
| `assets`         | name, category (hardware/accessory/digital), serial_number (unique where not null), status                                         |
| `asset_issues`   | asset_id, assignment_id, issued_by_id, issued_at, issue_serial, issue_notes, returned_at, return_serial, return_notes, status      |
| `reimbursements` | trainer_id, assignment_id, category, amount, description, proof_file_id, status, reviewed_by_id, reviewed_at, review_note, paid_at |
| `flags`          | assignment_id, raised_by_id, severity, description, status, action_taken, resolved_by_id, resolved_at, resolution_note             |

**Read model**

`pool_entries` — a SQL view unioning pool-eligible candidates and re-hire-eligible deboarded
trainers into one searchable shape.

### 7.3 Index strategy

Beyond primary keys and the unique constraints above:

- `applications (position_id, status)` — the open-positions board
- `applications (candidate_id, created_at DESC)` — candidate history
- `interviews (status, scheduled_at)` — pipeline and reminder scans
- `interviews (interviewer_id, scheduled_at)` — interviewer's queue
- `attendance_records (assignment_id, work_date DESC)` — trainer history
- `attendance_records (work_date, status)` — daily roster across projects
- `leave_requests (status, created_at)` and `(approver_id, status)` — approval queues
- `reimbursements (status, created_at)` — approval queue
- `audit_logs (entity_type, entity_id, created_at DESC)` and `(actor_user_id, created_at DESC)`
- GIN trigram indexes on `candidates.name`, `candidates.email`, `trainers.employee_code` for search

### 7.4 File limits and retention

| Document            | Types                           | Max size | Rationale                                                    |
| ------------------- | ------------------------------- | -------- | ------------------------------------------------------------ |
| Resume              | pdf, doc, docx                  | 5 MB     | A text CV is well under 1 MB; 5 MB tolerates embedded images |
| Aadhaar / PAN       | jpg, jpeg, png, pdf             | 5 MB     | A phone photo of an ID card is 2–4 MB                        |
| Certificates        | pdf, jpg, jpeg, png             | 10 MB    | Multi-page scanned certificates                              |
| Reimbursement proof | jpg, jpeg, png, pdf             | 5 MB     | Receipt photos                                               |
| Deliverable         | pdf, doc, docx, ppt, pptx, xlsx | 25 MB    | Course material with slides                                  |

Validation is by **magic bytes**, not by file extension or client-declared MIME type.

| Data                | Retention                                                   |
| ------------------- | ----------------------------------------------------------- |
| Identity documents  | 7 years after deboarding, then purged                       |
| GPS coordinates     | 12 months, then coordinates nulled (attendance record kept) |
| Audit logs          | 3 years                                                     |
| Notifications       | 90 days                                                     |
| Rejected candidates | 2 years unless pool-eligible                                |

---

## 8. API Requirements

### 8.1 Conventions

- Base path `/api/v1`; REST; JSON only
- Lists: `GET /resource?page=1&pageSize=25&sort=-createdAt&q=text&status=active`
- List response: `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`
- Single resource: the object itself
- Errors: **RFC 9457 Problem Details**
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
- **Unknown query parameters return 400 naming the offending parameter.** (Strict validation is
  kept, but it must say what it rejected — silent or opaque rejection is what previously produced
  an unexplained "Validation failed".)
- Mutating requests accept an `Idempotency-Key` header; replays within 24 h return the original response
- Every response carries `X-Request-Id`

### 8.2 Endpoint surface

**Auth** — `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` ·
`GET /auth/me` · `POST /auth/change-password` · `POST /auth/forgot-password` · `POST /auth/reset-password`

**Users** — `GET|POST /users` · `GET|PATCH /users/:id` · `POST /users/:id/disable` · `POST /users/:id/reset-password`

**Projects** — `GET|POST /projects` · `GET|PATCH|DELETE /projects/:id` ·
`GET /projects/:id/assignments` · `GET /projects/:id/roster` (today's attendance) ·
`GET /projects/:id/deboardings` · `GET|POST /projects/:id/holidays`

**Positions** — `GET|POST /positions` · `GET|PATCH /positions/:id` · `POST /positions/:id/close` ·
`GET /positions/:id/applications`

**Candidates & applications** — `GET|POST /candidates` · `GET|PATCH /candidates/:id` ·
`POST /applications` · `GET /applications/:id` · `POST /applications/:id/screen` ·
`POST /applications/:id/withdraw`

**Interviews** — `GET /interviews` · `GET /interviews/pipeline` (per-position counts) ·
`POST /interviews` · `GET|PATCH /interviews/:id` · `POST /interviews/:id/outcome` ·
`POST /interviews/:id/reschedule` · `POST /interviews/:id/cancel`

**Offers** — `GET|POST /offers` · `GET /offers/:id` · `POST /offers/:id/send` ·
`POST /offers/:id/respond` · `POST /offers/:id/revise` · `POST /offers/:id/convert-to-trainer`

**Trainers** — `GET /trainers` · `GET|PATCH /trainers/:id` · `GET|POST /trainers/:id/documents` ·
`POST /trainers/:id/documents/:docId/verify` · `POST /trainers/:id/assignments` ·
`GET /trainers/:id/summary`

**Attendance** — `POST /attendance/punch-in` · `POST /attendance/punch-out` ·
`GET /attendance` · `GET /attendance/me` · `POST /attendance/:id/corrections` ·
`GET /attendance/corrections` · `POST /attendance/corrections/:id/decide`

**Leave** — `GET|POST /leave-requests` · `GET /leave-requests/:id` ·
`POST /leave-requests/:id/decide` · `POST /leave-requests/:id/cancel` · `GET /leave-requests/balance`

**Operations** — `GET|POST /daily-logs` · `POST /daily-logs/:id/unlock` ·
`GET|POST /deliverables` · `PATCH /deliverables/:id` ·
`GET|POST /assets` · `POST /assets/:id/issue` · `POST /asset-issues/:id/return` ·
`GET|POST /reimbursements` · `POST /reimbursements/:id/decide` · `POST /reimbursements/:id/mark-paid` ·
`GET|POST /flags` · `POST /flags/:id/resolve`

**Deboarding** — `POST /deboardings` · `GET|PATCH /deboardings/:id` · `POST /deboardings/:id/complete`

**Pool** — `GET /pool` · `POST /pool/:entryId/create-application`

**Files** — `POST /files/upload-url` (presigned PUT) · `POST /files/:id/confirm` ·
`GET /files/:id/download-url` (presigned GET, 60 s TTL, audited)

**Platform** — `GET /notifications` · `POST /notifications/:id/read` ·
`GET /audit-logs` · `GET /audit-logs/export.csv` ·
`GET /dashboard/summary` (role-shaped) · `GET /health` · `GET /ready`

Every list endpoint above supports `?format=csv` where an export is useful.

---

## 9. UI/UX Structure and Major Screens

### 9.1 Design system

Four core colours plus neutrals, one light theme, no dark mode (see §15.10):

| Token   | Hex                   | Use                                         |
| ------- | --------------------- | ------------------------------------------- |
| Canvas  | `#F7F9F8`             | Page background                             |
| Surface | `#FFFFFF`             | Cards, tables, panels                       |
| Primary | `#0F766E` (teal 700)  | Actions, active nav, links — 5.4:1 on white |
| Ink     | `#1E293B` (slate 800) | Body text — 13.9:1 on white                 |
| Accent  | `#B45309` (amber 700) | Pending, warning, overdue — 4.9:1 on white  |

Semantic status colours derive from these three plus a single red (`#B91C1C`) reserved for
destructive actions and errors. Every status is communicated by **label plus colour**, never colour
alone. Target: WCAG 2.1 AA, full keyboard navigation, visible focus rings, `aria-live` regions for
async results.

### 9.2 Shell

- **One login page** for everyone, with role-based redirect after authentication (see §15.11).
- Persistent left sidebar; content area to its right; top bar with search, notification bell,
  and account menu.
- Responsive: sidebar collapses to a drawer below 1024 px; tables become stacked cards below
  768 px so trainers can punch in and submit logs from a phone.

### 9.3 Admin navigation

```
Dashboard
Onboarding
  ├─ Open Positions
  ├─ Interview Pipeline
  └─ Offer Letters
Running Projects
Deboarding
Talent Pool
Flags
Audit Log            (Super Admin, Manager, HR)
Settings & Users     (Super Admin)
```

### 9.4 Admin screens

| Screen                 | Content                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**          | KPI tiles (open positions, interviews today, active trainers, pending approvals, open flags), an action queue of items awaiting _this user_, recent activity                                                                 |
| **Open Positions**     | Card grid; each card shows title, project, headcount, applicant count, and a stage breakdown bar. Opening a card replaces the content area with the applications table                                                       |
| **Applications table** | Rows: candidate, project, position, contact, email, resume link, LinkedIn, applied date, status. Row actions: screening decision, view candidate, schedule interview. Bulk screening supported                               |
| **Interview Pipeline** | Position cards with pipeline counts → position detail with three tabs: _Scheduled_ (sortable, includes not-yet-scheduled with an inline schedule form), _Conducted_ (outcome + recording link), _Missed_ (reschedule inline) |
| **Offer Letters**      | Tabs _Draft_, _Sent_ (sub-filters accepted / declined / awaiting), _All history_. Row expands to show every version of that offer                                                                                            |
| **Running Projects**   | Project cards (client, dates, headcount, today's attendance %) → project detail with a trainer roster showing name, lead badge, today's status, punch in/out                                                                 |
| **Trainer profile**    | Header (name, code, project, status) + tabs: Overview (contact, work email, joining date, salary — permission-gated), Documents, Assignments, Attendance, Daily Log, Deliverables, Leave, Assets, Reimbursements, Flags      |
| **Deboarding**         | Project list → deboarded/deboarding trainers with last working day, asset reconciliation state, F&F status. Row expands into the full checklist                                                                              |
| **Talent Pool**        | Searchable table with filters (last status, reason, worked-before, position, project) and a "Consider for position" action                                                                                                   |
| **Flags**              | Queue of open flags with severity, trainer, project, raiser, age; resolve with an action                                                                                                                                     |
| **Audit Log**          | Filterable by actor, entity, action, date range; row expands to a before/after diff; CSV export                                                                                                                              |

### 9.5 Trainer screens

| Screen             | Content                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Home**           | Punch in/out card (large, primary action), today's status, document-completion banner if pending, leave balance, open items |
| **My Profile**     | Personal details, document upload cards with per-document status and reject reasons                                         |
| **Attendance**     | Monthly calendar + list view, punch times, status per day, raise correction                                                 |
| **Daily Log**      | Today's sessions with an add-session form; past days read-only once submitted                                               |
| **Deliverables**   | Syllabus and Other Duties lists with completion toggles and file attachments                                                |
| **Leave**          | Balance card, request form (date range, half-day toggle), request history with status                                       |
| **Reimbursements** | Submit form (amount, category, description, proof) and history with status                                                  |
| **Resources**      | Issued assets with serial numbers, issue dates, and digital resources such as work email                                    |

### 9.6 State handling rules (non-negotiable)

Every data-driven view implements four states explicitly: **loading** (skeleton, not a spinner
over stale data), **empty** (explanatory copy plus the primary action), **error** (what failed,
what to do, a retry button), **populated**. Every route is wrapped in an error boundary so a render
failure degrades to an inline error panel — never a blank page.

---

## 10. Security and Authentication

### 10.1 Authentication

- Email + password. **Argon2id** (m=19456, t=2, p=1) hashing.
- **Access token**: JWT, 15-minute TTL, held in memory only — never `localStorage`, never a cookie.
- **Refresh token**: 7-day TTL, opaque 48-byte random value, stored **hashed** server-side, sent
  as `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie.
- **Rotation with reuse detection**: every refresh issues a new token and revokes the old one.
  Presenting an already-revoked token revokes the whole family and forces re-login.
- Forced password change: `must_change_password` blocks every route except `/auth/change-password`,
  enforced server-side (not only by the UI).
- Lockout: 5 failed attempts within 15 minutes locks the account for 15 minutes; both the failures
  and the lockout are audited.
- Login responses are uniform for unknown email and wrong password, and take constant time.

### 10.2 Authorisation

The permission matrix in §3.2 lives in `packages/shared` as data, is enforced by the guard
pipeline, and is **consumed directly by the test suite** — so the matrix and the behaviour cannot
diverge.

### 10.3 Data protection

- TLS 1.2+ everywhere; HSTS; HTTP redirects to HTTPS.
- S3 bucket private, SSE-KMS encrypted, no public access; all reads via 60-second presigned URLs.
- RDS encrypted at rest, in a private subnet, not publicly accessible.
- Aadhaar/PAN numbers not persisted (document + last four only).
- Secrets in AWS Secrets Manager in production; `.env` locally; nothing secret in the repository.
- Salary and identity-document access is audited on read, not just on write.

### 10.4 Application hardening

- Helmet security headers plus a strict Content-Security-Policy.
- CORS allow-list of exact origins; credentials enabled only for those.
- Rate limits: 5/15min on login per IP+email, 10/min on file upload URLs, 100/min global per user.
- All input validated with Zod at the edge; Prisma parameterises every query.
- No user-supplied HTML is rendered; React escapes by default.
- CSRF: the refresh cookie is `SameSite=Strict` and the refresh endpoint additionally requires a
  matching `X-CSRF-Token` header (double-submit).
- Dependency scanning (`npm audit`, Dependabot) and secret scanning in CI.

---

## 11. Error Handling and Validation

### 11.1 Backend

Three error classes, mapped by a single global filter:

| Class         | HTTP      | Example                                                                           |
| ------------- | --------- | --------------------------------------------------------------------------------- |
| Validation    | 400 / 422 | Malformed body, unknown query param, failed Zod schema                            |
| Domain rule   | 409       | "Already punched in today", "Leave balance exceeded", "Illegal status transition" |
| Authorisation | 401 / 403 | Missing token, wrong role, out-of-scope resource                                  |

Every domain rule violation returns a **specific** `type` and human-readable `detail` — never a
generic message. Unexpected errors return 500 with a `traceId` and nothing else; the full stack
goes to the logs, correlated by that id.

**State transitions are validated centrally.** Each lifecycle has one transition table in
`packages/shared`; services call `assertTransition(entity, from, to)` and an illegal move throws a
409 naming both states. No status is ever assigned by an ad-hoc write.

### 11.2 Frontend

- A route-level error boundary plus a global boundary; a crash renders an inline panel with a
  reload action, never a blank screen.
- API errors are surfaced from `problem.detail`, with field errors mapped onto form inputs by path.
  **The client never replaces a real error with a generic one** — the original is always logged
  and the specific message shown.
- Mutations use optimistic updates only where safely reversible; everything else shows a pending
  state and disables the trigger.
- Offline / network failure gets its own message distinct from a rejected request.

### 11.3 Validation split

| Kind                                                      | Where                            |
| --------------------------------------------------------- | -------------------------------- |
| Shape, type, format, length                               | Zod, shared by client and server |
| Business rules (balances, transitions, ownership)         | Server domain services only      |
| Structural invariants (uniqueness, referential integrity) | Database constraints             |

Client-side validation exists for responsiveness; the server never trusts it.

---

## 12. Deployment and Environment Requirements

### 12.1 Environments

| Env            | Runs on                                                | Data                | Purpose             |
| -------------- | ------------------------------------------------------ | ------------------- | ------------------- |
| **Local**      | Docker Compose — api, worker, postgres, minio, mailpit | Seeded              | Development         |
| **Staging**    | Single EC2 + RDS                                       | Seeded, refreshable | Verification, demos |
| **Production** | Single EC2 + RDS (Multi-AZ)                            | Real                | Live                |

### 12.2 Local setup

```bash
pnpm install
cp .env.example .env
docker compose -f infra/compose/docker-compose.dev.yml up -d   # postgres, minio, mailpit
pnpm --filter api prisma migrate dev
pnpm --filter api seed
pnpm dev                                                        # api :4000, web :5173
```

Seeded accounts cover every role; the seed prints them. Passwords are environment-specific and
generated, never committed.

### 12.3 Production topology

- **EC2 t3.medium** (Amazon Linux 2023) running Docker Compose: `caddy`, `api`, `worker`
- **Caddy** terminates TLS with automatic Let's Encrypt certificates, serves the built SPA, and
  reverse-proxies `/api` — chosen over Nginx because automatic certificate management removes an
  entire class of expiry incidents
- **RDS PostgreSQL 16**, private subnet, automated backups with 7-day point-in-time recovery
- **S3** private bucket with versioning and lifecycle rules
- **SES** for transactional email
- **Secrets Manager** for all credentials; the EC2 instance role grants read on its own secrets,
  read/write on its bucket prefix, and SES send — nothing more
- **CloudWatch** for log aggregation (Pino JSON via the CloudWatch agent), plus alarms on 5xx
  rate, API latency p95, CPU, disk, and RDS free storage

### 12.4 CI/CD

**On pull request:** lint → typecheck → unit tests → integration tests (Testcontainers Postgres) →
build both apps → Playwright E2E against an ephemeral compose stack. All must pass to merge.

**On merge to `main`:** build multi-stage images → push to GHCR tagged with the commit SHA → SSH
to the target host → pull → `prisma migrate deploy` → restart → poll `/ready` → on failure,
re-tag the previous image and restart (automatic rollback).

Migrations are forward-only and must be backwards-compatible with the previously deployed code
(expand/contract) so a rollback never leaves the schema ahead of the application.

### 12.5 Honest limitation

A single EC2 host cannot do zero-downtime or blue/green deployment; a deploy costs roughly 10–20
seconds of unavailability. For an internal tool of this size that is an acceptable trade against
the cost and operational surface of ALB + a second instance. The documented upgrade path — put an
ALB in front, run two instances, switch to rolling deploys — requires no application change, only
Terraform, because the application holds no local state.

### 12.6 Operational readiness

- `GET /health` (process alive) and `GET /ready` (database and S3 reachable)
- Structured JSON logs with request id, user id, route, status, duration; PII never logged
- OpenTelemetry instrumentation present but exporting to a no-op by default
- Runbooks in `docs/runbooks/` for restore-from-backup, rollback, and credential rotation

---

## 13. Testing Strategy

| Layer       | Tool                                | Scope                                                                                       | Gate                                                                  |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit        | Vitest                              | Domain services, state machines, balance calculations, date/IST helpers                     | 85% lines on `modules/**/*.service.ts`; **100% on transition tables** |
| Integration | Vitest + Supertest + Testcontainers | Every endpoint against a real Postgres — validation, persistence, side effects              | All endpoints exercised                                               |
| Permission  | Vitest, table-driven                | The §3.2 matrix executed cell by cell: every role × every endpoint, asserting allow or deny | 100% of the matrix                                                    |
| Workflow    | Vitest                              | Every legal transition succeeds; every illegal transition returns 409                       | 100% of transitions                                                   |
| Contract    | Vitest                              | Shared Zod schemas validate real API responses, catching client/server drift                | All shared schemas                                                    |
| E2E         | Playwright                          | Seven critical journeys (§13.1)                                                             | All green before deploy                                               |
| Smoke       | Playwright                          | Login + dashboard load per role, run post-deploy against the live environment               | All green                                                             |

### 13.1 E2E journeys

1. HR creates a position → adds a candidate → screens _proceed_ → schedules an interview
2. Interviewer records _selected_ → HR sends offer → candidate accepts → converted to trainer
3. Trainer first login → forced password change → uploads documents → HR verifies
4. Trainer punches in and out; duplicate punch is rejected; correction requested and approved
5. Trainer requests half-day leave → Project Lead approves → attendance reflects it → balance decrements
6. Trainer submits a ₹15,000 reimbursement → HR cannot approve → Manager approves → marked paid
7. Deboarding: assets returned and reconciled → F&F settled → trainer appears in Talent Pool

### 13.2 Specific hardening tests

- Attendance: duplicate punch-in, punch-out before punch-in, punch without location, cross-midnight
- Files: oversized upload, wrong extension, correct extension with mismatched magic bytes
- Auth: refresh-token reuse revokes the family; lockout after 5 failures; `must_change_password`
  blocks other routes server-side
- Scoping: a Project Lead requesting another project's roster gets 403; a Trainer requesting
  another trainer's attendance gets 403
- Timezone: an interview scheduled 23:45 IST reminds correctly; DST-free IST arithmetic verified

---

## 14. Assumptions Made

Numbered so they can be individually overridden.

| #   | Assumption                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Single organisation, single tenant. No white-labelling.                                                                                                 |
| A2  | Currency is INR throughout; no multi-currency.                                                                                                          |
| A3  | All operational times are IST (Asia/Kolkata). Stored UTC, rendered IST. India has no DST.                                                               |
| A4  | Reimbursement approval ceiling for HR is **₹10,000**; above that requires Manager approval. (The original ceiling was never stated.)                    |
| A5  | Leave allowance is **3 full-day equivalents per assignment**, half-day = 0.5, no carry-over.                                                            |
| A6  | Attendance grace period is **15 minutes**, configurable per project.                                                                                    |
| A7  | Working week is Monday–Saturday by default, configurable per project; holidays are configurable org-wide and per project.                               |
| A8  | A trainer may hold multiple concurrent assignments; leave balance is tracked per assignment.                                                            |
| A9  | Interviews are single-interviewer. Panel interviews are modelled as multiple rounds.                                                                    |
| A10 | Offer letters are sent outside the system; ManagedOps records status and optionally stores the sent PDF.                                                |
| A11 | Work email is an address recorded by an administrator. ManagedOps does not provision mailboxes.                                                         |
| A12 | Candidate intake is manual by HR in v1; the `source` field and the application model are built so a public apply page can feed the same pipeline later. |
| A13 | Email is the only external notification channel in v1. No SMS or WhatsApp.                                                                              |
| A14 | GPS is captured for record-keeping only. A denied location permission does not block a punch.                                                           |
| A15 | Attendance is self-service by the trainer; there is no biometric or badge integration.                                                                  |
| A16 | Employee codes are system-generated and sequential per year (`MO-2026-0001`).                                                                           |
| A17 | Uploaded files are validated by magic bytes; antivirus scanning is deferred to v1.1 (the `scan_status` column exists now).                              |
| A18 | Notification preferences are not user-configurable in v1; transactional email always sends.                                                             |
| A19 | Reporting is dashboard summaries plus CSV export. No BI tool integration.                                                                               |
| A20 | Browser support: last two versions of Chrome, Edge, Safari and Firefox. No IE.                                                                          |

---

## 15. Requirements Removed, Merged or Modified

Each item states what the reference documents asked for, what this specification does instead, and why.

### 15.1 Candidate status enum reduced from 15 values to a two-entity model

**Was:** one candidate status enum containing `offer_unsent`, `offer_sent`, `offer_accepted`,
`offer_rejected`, `offer_revision_requested`, `in_pool`, `past_employee` and more.
**Now:** a `Candidate` (the person) with a small status, an `Application` (person + position) that
carries the pipeline state, and an `Offer` entity that owns all offer states.
**Why:** the original duplicated offer state onto the candidate, guaranteeing the two would drift —
a dual-write bug waiting to happen. Separating person from application is also what makes the
Talent Pool genuinely reusable, since one person can have many applications over years.

### 15.2 `in_pool` and `past_employee` are no longer statuses

**Now:** the Talent Pool is a derived query over pool-eligible candidates and re-hire-eligible
deboarded trainers.
**Why:** a record cannot be both "rejected in interview" and "in pool" if those are the same field.
Deriving the pool means it can never be stale.

### 15.3 Trainer status enum split into three concepts

**Was:** `credentials_generated`, `password_change_required`, `active`, `on_leave`, `half_day`,
`leave_without_pay`, `flagged`, `deboarded`, `reusable_pool`, `archived` — all in one field.
**Now:** employment lifecycle (`pending_onboarding → active → deboarding → deboarded → archived`),
a `must_change_password` boolean on the user, daily attendance status on the attendance record, and
flags as their own records.
**Why:** "on leave today" is not an employment state; it changes daily and applies to a date, not a
person. Conflating them makes it impossible to answer "was this trainer active in March?"

### 15.4 Leave approval simplified from three-way parallel to single approver with escalation

**Was:** every leave request goes to Head Trainer _and_ Project HR _and_ Project Manager.
**Now:** the Project Lead decides; if undecided after 24 hours it escalates to the Manager and HR,
either of whom may decide. Any single approval is sufficient.
**Why:** requiring three people to act on a one-day leave against a three-day allowance is process
for its own sake. The escalation preserves the real requirement — leave never gets stuck — without
three approval queues, three notification paths and a partial-approval state to reason about.

### 15.5 Flag recipient picker removed

**Was:** the Project Lead selects one or more recipients from a list of project-associated HR and
managers.
**Now:** a flag automatically notifies the project's assigned Manager and HR.
**Why:** those two people are already stored as ownership fields on the project and are exactly who
should see it. The picker adds a UI, a join table and a way to send a flag to the wrong person, for
no gain.

### 15.6 Interviewer role scoped down (resolving a contradiction in the source documents)

**Was:** "Interviewer is an Admin User" who "can create, edit, delete… manage everything across the
system" — while a separate frozen assumption questioned whether Interviewers should see salary and
Aadhaar at all.
**Now:** Interviewer is a genuinely restricted role: interviews assigned to them, plus the
candidate's name, contact and resume. No salary, no identity documents, no projects, no deletion.
**Why:** the two statements cannot both hold. An interviewer needs enough to conduct and record an
interview; granting them delete rights over projects and visibility of PAN and salary is a data
exposure with no business justification.

### 15.7 24-hour document deadline softened from a hard lock to reminders plus visibility

**Was:** trainer "gets 24 hours to upload required documents."
**Now:** a 24-hour target with reminders at 24 h and 72 h, escalation to the onboarding HR at 72 h,
and a persistent "documents incomplete" badge. Access is not revoked.
**Why:** the business goal is that documents get collected, and reminders plus visibility achieve
that. Locking a new hire out on day two for a scan they could not take creates support load and
delays the project they were hired for.

### 15.8 Auto-deletion of stale interviews replaced with archival

**Was:** interviews missed for more than 30 days are "automatically deleted or archived."
**Now:** archived, never deleted. The record and its audit trail persist.
**Why:** automatically destroying recruitment records is a data-loss and compliance hazard. Archival
achieves the same clean UI with none of the risk.

### 15.9 "Every module extractable to a microservice" downgraded to a design principle

**Was:** a stated deliverable.
**Now:** modules have clean boundaries and communicate through interfaces and events, but no
extraction scaffolding (per-module deployment, service discovery, distributed transactions) is built.
**Why:** at 300 trainers and 50 req/s, microservices cost far more than they return. Keeping the
boundaries clean preserves the option at essentially zero cost; building for the split now is
speculative work against a need that may never arrive.

### 15.10 Dark mode dropped

**Was:** "minimal dark mode if needed."
**Now:** one polished, accessible light theme.
**Why:** a second theme doubles the surface for every colour and contrast decision. "If needed"
signals it was never required; it can be added later behind the existing design tokens.

### 15.11 Separate admin and trainer login pages replaced with one login and role-based redirect

**Was:** a distinct "Welcome Admin" page and a separate trainer login (a request tied to the paused
OAuth work).
**Now:** a single login page; the API decides where the authenticated user lands.
**Why:** two pages means users hitting the wrong one and bouncing, two auth surfaces to secure, and
a public page that advertises which URL admins use. The split can return in one commit if you add SSO.
**This one is easy to reverse — say the word and it goes back.**

### 15.12 "Generate work email and password" narrowed

**Was:** a UI action to generate a work email and password for a trainer.
**Now:** an administrator records the work email address assigned by IT; the only credential
ManagedOps issues is the ManagedOps login.
**Why:** actually creating a mailbox requires a Google Workspace or Microsoft 365 admin integration
that is not in scope and was almost certainly not intended.

### 15.13 Travel demoted from a module to fields

**Was:** "Travel Plans" listed as an onboarding component.
**Now:** travel fields on onboarding (arrival date, mode, cost) and on the deboarding record.
**Why:** three or four fields do not warrant a module, a screen and an API surface.

### 15.14 Deliverables "to-do list behaviour" merged into the checklist

**Was:** text entries that "behave like to-do lists" plus a separate uploaded-docs area.
**Now:** one deliverables list where each item has a title, optional description, optional file
attachment and a completion state.
**Why:** these were the same feature described twice.

### 15.15 Offer PDF gap closed

**Was:** "no PDF generation required" with no statement of how the offer reaches the candidate.
**Now:** the offer is sent out of band; ManagedOps records the send, the response, and optionally
stores the PDF that was sent as an attachment.
**Why:** removes an unstated hole in the workflow at negligible cost.

### 15.16 Aadhaar and PAN numbers no longer stored as data

**Was:** implied fields on the trainer record.
**Now:** the uploaded document plus the last four characters only.
**Why:** storing full government identifiers creates disproportionate breach exposure under India's
DPDP Act. Verification needs the document; identification needs four characters.

### 15.17 Standalone Settings and Reporting modules dropped

**Now:** a small key-value settings table with a Super Admin screen, and dashboard summary endpoints
plus CSV export in place of a reporting module.
**Why:** neither had enough distinct behaviour to justify a bounded context in v1.

### 15.18 MongoDB replaced with PostgreSQL

Covered in full in §5.2.

---

## 16. Delivery Plan

| Phase                          | Contents                                                                                                    | Estimate  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------- |
| **0 — Foundations**            | Monorepo, Docker Compose, Prisma schema + migrations, auth, RBAC, audit, files, notifications, UI shell, CI | 2 weeks   |
| **1 — Recruitment**            | Projects, positions, candidates, applications, screening, interviews, offers, reminder jobs                 | 2 weeks   |
| **2 — Onboarding & workforce** | Offer→trainer conversion, documents, assignments, trainer profile, project roster                           | 1.5 weeks |
| **3 — Delivery operations**    | Attendance, corrections, leave, daily log, deliverables, assets, reimbursements, flags                      | 2.5 weeks |
| **4 — Exit & reuse**           | Deboarding, Talent Pool, dashboards, exports                                                                | 1 week    |
| **5 — Hardening & deploy**     | E2E suite, permission matrix tests, security pass, Terraform, staging, runbooks                             | 1.5 weeks |

**Total: ~10.5 engineer-weeks.** Phases 0–2 produce a demonstrable end-to-end hire; each phase ends
with tests green and the stack deployable. All five are complete — see §16a.

### Deferred to v1.1+

Google/GitHub SSO for admins · antivirus scanning on upload · public apply page · ALB and
two-instance rolling deploys · notification preferences · advanced reporting · offer PDF generation
· mobile app.

---

## 16a. Build Status

**All five phases are complete and verified.**

_Phase 0 — foundations:_ monorepo, full data model and migrations, authentication,
the permission layer, audit trail, file storage, notifications, the scheduled-job
runner, the UI shell, and CI.

_Phase 1 — recruitment:_ projects and positions, candidates and applications,
screening, the interview pipeline with IST reminders and archival, versioned
offers, and the three Onboarding screens.

_Phase 2 — onboarding and workforce:_ offer-to-trainer conversion, employee
codes, the document checklist with verification and staged reminders, automatic
activation, assignments and the project roster, and the four workforce screens.

_Phase 3 — delivery operations:_ attendance with GPS and a nightly close,
corrections, leave with balances and escalation, the daily log, deliverables,
the asset register, reimbursements with a two-tier limit, flags, and the
trainer's own screens alongside the approver's queue.

_Phase 4 — exit and re-use:_ deboarding with asset reconciliation and the F&F
settlement, the Talent Pool as a derived query, role-shaped dashboards, and CSV
export on the major lists.

_Phase 5 — hardening and deployment:_ the executable permission matrix across
every route, the file-access security pass, the Audit Log and Users screens,
Terraform for the whole estate, four runbooks, and the browser suite in CI.

_Beyond the five phases:_ the commercial side (§1.3 put payroll processing and
invoicing out of scope, but not knowing what a project earns) — clients, agreed
day rates and derived margin; skills and availability matching behind Find
Trainers; the payroll input register, which hands off to whatever runs payroll
rather than running it; the quality feedback loop, whose summary feeds the
re-hire decision; and document expiry, which makes the checklist ongoing
compliance rather than a one-time gate. Then an information-architecture pass
over the sidebar and the trainer profile, and two additions the reference
documents did not anticipate: §15.5 assumed email was enough to reach a contract
trainer, which it is not — six operational messages now also go to a phone over
WhatsApp, falling back to SMS — and §10.1's password policy is not a sufficient
guard on an account that can open every trainer's Aadhaar, so the roles the
matrix marks sensitive now hold a second factor.

| Check                                   | Result      |
| --------------------------------------- | ----------- |
| Shared contract tests                   | 252 passing |
| API integration tests (real PostgreSQL) | 752 passing |
| Browser tests (desktop + mobile)        | 168 passing |
| Typecheck, formatting, both builds      | Clean       |

Every screen in §9.4 and §9.5 is implemented. There are no placeholders left.

### Corrections this build surfaced

Phase 0:

- **§3.2** — a Project Lead also holds the trainer self-service capabilities,
  scoped to their own records. A head trainer teaches, so they punch in and take
  leave like anyone else; the original matrix accidentally denied them both.
- **§3.2** — the four self-service capabilities are withheld from every
  administrative role, which has no trainer profile to act on.
- **§11.1** — the trace id is assigned by application middleware rather than by
  the HTTP logger. It is part of the error contract, so it cannot depend on the
  logging transport being mounted.

Phase 1:

- **§3.4** — the three-layer permission model needed a fourth rule: a scope
  predicate is combined with a request's filters under `AND`, never merged into
  the same object. Both were live defects. A scope naming `id` overwrote an
  explicit `id`, so fetching another project returned _your own_ with a 200; and
  a query parameter written after the scope overwrote it, so `?projectId=` read
  straight past it. `scopedWhere()` now makes the scope a floor no filter can
  raise, and the scoping suite tests both directions.
- **§4.1** — an application moves `applied → screening → interviewing` as one
  step when a screening outcome is recorded, because the transition table has no
  direct `applied → interviewing` edge and a screening call legitimately does both.
- **§4.2** — a candidate may hold only one live application at a time. Without
  it, two projects can interview the same person in parallel without either
  knowing.

Phase 2:

- **§4.3** — a trainer becomes active on two conditions, not one: every mandatory
  document verified _and_ an assignment to work on. Activating on documents alone
  produced an active trainer with nothing to do, which the roster then had no
  honest way to show.
- **§7** — the temporary password is emailed only after the conversion
  transaction commits. Sending inside the transaction hands out credentials for
  an account that may still roll back.
- **§9** — the checklist is one component serving both HR and the trainer, with
  `canVerify` and `canUpload` deciding what appears. Two components drift; the
  same screen with different verbs does not.
- **§11.2** — Aadhaar and PAN ask for their last four characters _before_ the
  file is uploaded. Validating afterwards means the file has already gone to
  storage when the request is refused.

Phase 3:

- **§3.4** — the permission model needed a fifth rule: a screen that says "my"
  must ask for the caller's own records explicitly. A Project Lead's read
  capability is project-scoped, so `My Work` and `My Leave` listed their whole
  team. `mine=true` is combined with the caller's scope under `AND`, so it can
  only ever narrow — an administrator asking for "mine" gets nothing, not
  everything.
- **§4.5** — `holiday` and `weekly_off` are derived from the project calendar
  rather than written per trainer per day. They are facts about a project, not
  about a person; storing them would be a quarter of a million rows a year that
  go stale the moment a holiday is added. The API still returns those statuses,
  so the contract is unchanged.
- **§4.5** — a working day is only an absence once it is over. The nightly close
  decides; the calendar showing today as absent at 10am is a prediction, not a
  record.
- **§4.5** — the attendance transition table gained `present → missing_punch_out`
  and `late → missing_punch_out`. A punch-in records the day optimistically, and
  without that edge the nightly close could not downgrade a day nobody closed —
  which is the only route to a correction.
- **§9.6** — the punch must not depend on the browser answering. The Geolocation
  API's own `timeout` starts only after the permission is resolved, so a browser
  that never answers calls neither callback and the punch hangs with no
  feedback. The client races its own deadline; the worst case is a punch without
  coordinates, which the product already handles.
- **§8.1** — one endpoint may declare several capabilities, any one of which
  admits the caller (`RequireAnyCapability`). The leave and claim lists are a
  queue to an approver and a history to the person who filed them; the
  alternative, a parallel `/mine` route per resource, duplicates the pagination
  and filtering of the endpoint it shadows, and the duplicate is where the scope
  eventually gets forgotten.

Phase 4:

- **§4.10** — `assetsReconciled` is derived from the register, never accepted
  from the client. A tick saying the laptop came back is worth nothing next to a
  row saying it did not, and the refusal names the specific items rather than
  only declining.
- **§4.11** — the pool shows the rejection reason, not the screening notes. The
  reason is the field §4.1 made mandatory precisely so a pool entry explains
  itself; the notes are the internal record of the call.
- **§3.2** — `deboarding.read` is removed from the Trainer grant. Nothing shows
  a trainer their own exit checklist, and a capability no screen serves only put
  an administrator's queue in their sidebar.
- **§9.4** — a project card counts _active_ assignments. Counting every
  assignment ever made put "5 trainers" on a card whose roster then listed four.

Phase 5, the security pass:

- **§10.3 — the serious one.** `GET /files/:id/download-url` authorised nothing
  beyond "is signed in", and the document checklist handed every file id to
  anyone who could read the trainer's row. A Project Lead — deliberately denied
  `trainers.read_documents` — could therefore open a colleague's Aadhaar scan
  using an id the API had just given them. An unguessable identifier is not
  authorisation. Downloads are now authorised against the record the file
  belongs to, and the id is withheld from a caller who may not open it, so the
  defence does not live in one place.
- **§13.2** — the permission suite now walks the container rather than a list:
  every controller handler must declare a capability, be `@Public()`, or be
  named as intentionally open with a reason. A route added tomorrow is covered
  without anybody remembering to come back to the test.
- **§8.1** — `POST /trainers/:id/documents` declared no capability at all. The
  service authorised it correctly, but the guard had nothing to say; it now
  declares both audiences explicitly.
- **§2.5** — CSV escaping is shared and neutralises formula injection. The
  previous per-controller escape quoted commas and nothing else, so a field
  beginning with `=` was executed by whatever spreadsheet opened the export.

---

## 17. Decisions Needed Before Build Starts

Only these three genuinely change the shape of the work. Everything else above is a decision I have
made and documented.

1. **PostgreSQL instead of MongoDB** (§5.2) — the largest departure from the reference documents.
2. **Interviewer as a restricted role** (§15.6) — resolves a direct contradiction; confirm the
   restricted reading is what you intend.
3. **Single login page** (§15.11) — trivially reversible, but worth confirming now rather than after
   the UI is built.

If all three are acceptable, no further input is needed to begin Phase 0.
