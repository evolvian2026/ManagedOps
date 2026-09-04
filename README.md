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

### Running the browser suite

```bash
pnpm db:seed:fresh             # not db:seed — see below
pnpm dev                       # in another shell
pnpm test:e2e
```

`db:seed` is idempotent but it is not a reset: it restores the rows it owns and
cannot undo rows written on top of them. The browser suite punches trainers in,
screens applicants and reschedules interviews, so a second run against the same
database finds that work already done and fails. `db:seed:fresh` truncates
first, which is what makes the suite repeatable.

If Playwright reports a missing browser, the pinned version and the one on the
machine disagree. Point it at the installed binary rather than downloading a
second copy:

```bash
export PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome
```

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
  shared/      Zod schemas, enums, state machines, the permission matrix,
               and the margin and matching rules
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

| Command                                    | Does                                        |
| ------------------------------------------ | ------------------------------------------- |
| `pnpm dev`                                 | Runs the API and the web client together    |
| `pnpm build`                               | Builds everything                           |
| `pnpm typecheck`                           | Typechecks every package                    |
| `pnpm test`                                | Runs every test suite                       |
| `pnpm lint`                                | Lints every package                         |
| `pnpm test:e2e`                            | Runs the browser suite against a live stack |
| `pnpm db:seed`                             | Loads demo data (idempotent)                |
| `pnpm db:seed:fresh`                       | Truncates first, then loads demo data       |
| `pnpm infra:up` / `infra:down`             | Starts or stops the local backing services  |
| `pnpm --filter @managedops/api dev:worker` | Runs the scheduled-job worker               |

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

## How margin is worked out

The commercial side answers one question — did the work make money — and the
answer depends on an asymmetry worth stating plainly.

**Revenue is per day delivered.** A client is billed `billRatePerDay` for every
day a trainer actually taught. Weekly offs, holidays and approved leave are not
billed, because nothing was delivered on them.

**Cost is a monthly salary, spread over the period's working days.** A salaried
trainer is paid through holidays and approved leave alike, so their cost is not
per-day piecework. Each assignment carries the share it earned:

```
salary cost = (annual salary / 12) x months x (payable days / working days in the period)
```

The denominator is the **period**, never the assignment. An assignment that
began halfway through the month has half the payable days and so carries half
the month's salary — measuring it against its own length would charge every
partial assignment a full month.

Reimbursements approved in the period are added to the cost. `margin` is what is
left, and `marginPercent` is that as a share of revenue.

**An assignment with no rate is `unbilled`, not a loss.** Internal work exists,
and booking it at a 100% loss would make every roll-up above it meaningless — so
its cost is counted, its revenue is absent rather than zero, and the report says
how many such assignments are in the figure you are looking at.

The arithmetic lives in `packages/shared/src/rules.ts` (`tallyDays`,
`computeMargin`) and nowhere else; the API only feeds it facts. Every grouping —
by project, by client, by trainer — is a roll-up of the same per-assignment
figures, which is why the totals agree whichever way you cut them.

Who sees any of this is a capability, not a role: `billing.read` for the numbers,
`billing.manage` to set a rate, `clients.read` for the directory HR staffs
against. A rate is omitted from the payload entirely for anyone without
`billing.read` — not nulled, and not hidden in the client.

---

## How matching works

Two questions, answered separately and reported side by side: **can they do the
work**, and **are they free to**. They are deliberately not folded into one
ranking — the best-matched person is usually the busiest, and whether to pull
them off something else is a judgement with context the server does not have.

### Fit

Skills are a **canonical catalogue**, not free text on a profile. "React",
"ReactJS" and "react.js" typed into three profiles are three skills that never
match each other, which is the failure that makes a matching feature useless.

Scoring (`scoreMatch` in `packages/shared/src/rules.ts`) is out of 100:

| Component  | Weight | Rule                                           |
| ---------- | -----: | ---------------------------------------------- |
| Essentials |     60 | All or nothing — a missing one scores **0**    |
| Desirables |     25 | Pro rata across those the position lists       |
| Depth      |     10 | Mean proficiency across the skills asked about |
| Recency    |      5 | How current the **essential** skills are       |

Two rules do most of the work:

**A missing essential is disqualifying, not merely costly.** Ranking somebody
top because they are strong on four desirable skills while lacking the one
thing the position exists for is exactly the plausible-looking answer that
makes people stop trusting the tool.

**Recency is judged on the essentials, at their stalest.** Measuring it across
everything asked for lets a current soft skill vouch for a technical one nobody
has touched in years — "used within six months" would be true of the wrong
skill. And a position needing two skills is not served by somebody current on
one and years off the other.

Every component also states itself in a sentence. A ranked list with a bare
"87" against each name tells a staffer nothing they can act on or argue with,
so the API returns `reasons` and the screen shows them.

### Availability

Each assignment carries an `allocationPercent` — 100 by default, the common
case of one client, full time. `availabilityIn` measures free capacity at the
**busiest point** in the window rather than averaging across it: somebody free
for three weeks and booked for the fourth cannot take a month-long posting, and
an average would call them 75% free.

An open-ended commitment reports `availableFrom: null` — "we do not know when
they are free again", which is not "never" and not a date either. Inventing one
would put somebody on a shortlist they cannot be on.

### Nobody is in two places at once

Two constraints in `20260903120000_skills_and_capacity`:

- A **partial unique index** on `(trainerId, projectId) where status = 'active'` —
  which the service had been claiming in a comment while enforcing nothing, so
  two concurrent requests could both create the same live assignment.
- An **exclusion constraint** (`btree_gist`) refusing two overlapping full-time
  assignments for one trainer. Only full-time: no exclusion constraint can
  express "partial allocations summing to 100", and pretending otherwise in SQL
  would be worse than checking it where it can actually be checked.

The service checks the same rule first, so the caller gets a sentence naming the
project standing in the way rather than a constraint violation.

---

## The payroll register

An **input** register, not a payroll engine. It states the days and money
ManagedOps actually knows about, in the shape a payroll system wants them.
Nothing here computes PF, ESI, professional tax or TDS: those are statutory,
they change, and a wrong number that looks official is worse than no number.
Deductions belong to whoever files the returns.

Per person per month:

```
earned gross = (annual salary / 12) x (payable days / working days in the month)
```

**Payable days are counted per person, not per assignment.** Attendance is
recorded against an assignment, so somebody split across two projects has two
records for the same Tuesday — and is paid for that Tuesday once. A date
resolves to its best outcome: if any assignment records them as working or on
approved leave, the day is payable.

Alongside the salary, and separate from it: reimbursements approved during the
month, and a final settlement if one fell in it. Weekly offs and holidays are
on neither side of the ratio — nobody is docked for a Sunday, and nobody earns
a working day's pay for one either.

### It refuses to look final

Every row carries a readiness verdict, because a register that reads as settled
while a correction is pending is one somebody pays from. A row is blocked when:

- a working day has no attendance recorded — indistinguishable from an absence
  until somebody says which it was;
- an attendance correction is still awaiting a decision;
- leave overlapping the month is undecided;
- there is no salary on record to work from.

The figures are still shown, and the reasons travel into the CSV rather than
being lost when the file leaves. The register opens on the month that has
_finished_: defaulting to the one in progress would block every row for reasons
nobody can act on yet.

Figures are computed live rather than snapshotted, so a register run twice can
differ if somebody approved something in between. That is the honest behaviour,
and it is why the response carries the time it was generated.

`payroll.read` is held by Super Admin, Manager and HR. Not a project lead and
not a trainer: the register carries every salary on it.

---

## The feedback loop

`rehireEligible` drives the whole Talent Pool, and it used to be a tick box with
nothing behind it. Reviews are the evidence.

A review is recorded against the **assignment** it happened on — you can only
rate delivered work — and carries a source, an overall score out of five,
optional scores for knowledge, delivery and professionalism, and a respondent
count. It is **append-only**: there is no update endpoint and no `updatedAt`. A
review that turns out to be wrong is withdrawn with a reason and stays visible
as withdrawn; a correction is a new review. A performance record anybody can
quietly rewrite is worth much less than one they cannot.

### What the score is allowed to claim

```
within a source:  weighted by respondents  (forty learners are not one opinion)
across sources:   averaged equally         (one client is not drowned out by them)
```

Learners say whether they could follow, a client says whether they would have us
back, an observer says whether the craft was right. Blending them by headcount
would let a cohort bury the client, and it is the client who decides whether
there is more work.

**A thin record says so.** Below three reviews and ten respondents the summary
reports `confident: false` with a caveat, and the screens show that louder than
they show the number. A 5.0 from one review rendered like a verdict is exactly
the figure somebody would act on and should not.

A trend compares the last six months against everything before it, and only
calls a direction when the move is at least half a point — smaller than that is
noise, and naming it would get somebody managed on it.

### Who sees what

`reviews.write` belongs to Manager, HR and the project lead who watched the
session; `reviews.retract` is a Manager's alone. Nobody may review their own
delivery — a project lead both writes reviews and has a trainer profile, so
that is enforced in the service, not assumed.

A trainer holds `reviews.read` scoped to themselves and gets their **scores and
trend without the comments or the names**. Feedback nobody can see cannot
improve anybody; learner remarks are written under an expectation of anonymity,
and handing them over verbatim would change what people write. The API omits
those fields for that caller rather than the client hiding them.

The summary is attached to the deboarding detail and to every past trainer in
the Talent Pool, which is the entire point: the evidence sits next to the box
that decides whether we would work with them again.

---

## Documents that lapse

Aadhaar, PAN and a degree certificate do not expire. A police verification and
a medical certificate do — and a client asks for a _current_ one before somebody
sets foot on their site. Those two types were missing from the schema entirely;
they are there now, with an `expiresOn` beside them.

**Validity is derived, never stored.** A saved "valid" becomes a lie the moment
the calendar moves past it and nothing would notice, so `documentValidity`
computes it on every read — the same reason an attendance status comes from its
punches.

| State            | Means                          |
| ---------------- | ------------------------------ |
| `not_applicable` | This type does not lapse       |
| `valid`          | More than 30 days left         |
| `expiring_soon`  | Inside 30 days                 |
| `expired`        | The date has passed            |
| `missing_date`   | It lapses and nobody said when |

`missing_date` is the one that matters. A police verification filed without a
date is a gap to chase, not a document that is valid forever — treating an
absent date as "fine" is precisely how an expired one reaches a client site. So
it sits on the queue alongside the expired ones, and uploading a lapsing type
without a date is refused.

**They are not mandatory for onboarding.** They are ongoing compliance, not a
gate on somebody's first day: a police verification takes weeks to come back and
would block every joiner, and it would still say nothing about whether it is
current a year later.

`documents.expiry.remind` runs daily. A month out the trainer hears about it;
once it has actually lapsed HR does too, because an expired verification is not
the trainer's problem alone. Escalating a month early would train HR to ignore
the message that matters. `expiryReminderStage` stops a daily job repeating
itself, and uploading a replacement resets it so the new document is chased in
its turn.

The queue is scoped like any trainer read — a lead sees their team, a trainer
sees themselves — and the file id is withheld from anyone without
`trainers.read_documents`. Knowing that somebody's verification lapsed is a
different question from being allowed to open it.

---

## Reaching people on their phone

Email is the wrong channel for most of what this app has to tell a trainer. A
contract trainer between two client sites reads WhatsApp; the work address we
created for them on day one may never be opened. So six operational messages —
your account is ready, your documents are outstanding, a document is about to
lapse, your leave was decided, your correction was decided, your claim was
decided — also go to a phone.

**Neither channel accepts free text.** WhatsApp Business rejects a
business-initiated message that is not an approved template, and an Indian SMS
route requires content registered under TRAI's DLT rules before it will carry
it. So a mobile message is a template id plus values for its declared
parameters, never a string composed at the call site, and the catalogue lives in
`packages/shared/src/messaging.ts` — what we registered and what we send have to
be the same thing.

**The order of a template's parameters is part of its contract.** WhatsApp
substitutes them positionally, so a parameter declared but never used shifts
every value after it into the wrong slot — a message that is wrong rather than
refused. The shared test suite renders every template with sentinel values and
fails if any declared parameter goes unused.

**WhatsApp first, SMS as the fallback.** WhatsApp is cheaper, it is where these
trainers already are, and it carries more than 160 characters. SMS costs more
and says less, but it arrives on a phone with no app and no data — which is
exactly when the first one failed.

**The caller says what, never who to.** `notify()` takes a template and values;
the messaging service resolves each recipient's number, honours their opt-out
and picks the channel. A call site passing its own number is a call site that
can send one person's leave decision to another's phone.

**Every attempt is recorded, including the ones not made.** `message_deliveries`
holds one row per attempt with the channel, the provider's message id and the
error — because "did the trainer get the reminder?" is a question that gets
asked about leave decisions and document deadlines. Not sending is recorded too,
and the two reasons read differently: a number nobody has is one to collect, an
opt-out is a choice to respect. Numbers are stored masked; the contact record is
on the user, and a log queried daily has no reason to hold every mobile number
in the company.

**A number is normalised on the way in, and a constraint keeps it that way.**
`phoneSchema` transforms rather than merely validating, so `+91 98000 01002` and
`09800001002` become one stored value, and a CHECK constraint refuses anything
that is not `+91` followed by ten digits. Nothing below the messaging layer
re-parses a number before sending to it.

Locally the `log` transport renders each message into the application log, the
way Mailpit catches email. It is not a stub that always succeeds: numbers in a
reserved range fail, so the fallback and the failure recording are exercised by
the same code that runs in production.

---

## The second factor

An account that can open identity documents or read what people are paid is
worth stealing, and a password alone is a poor guard on one: it is reused, it is
phished, and one of these accounts opens every trainer's Aadhaar at once.

**Which roles need one is derived, not listed.** `mfaRequiredFor` walks the same
permission matrix the API enforces, and it turns on _scope_ rather than on
holding a capability at all. A project lead holds `trainers.read_salary` — over
themselves — and making them carry an authenticator to look at their own payslip
would be theatre with a real cost in forgotten phones. HR holds the same
capability over everybody, which is a different thing. Being derived, it cannot
fall behind: a role given `payroll.read` at `all` tomorrow needs a second factor
from the moment the matrix says so.

**A challenge is not a session.** A correct password from a privileged account
returns a short-lived, single-use token that opens nothing except the verify and
enrol endpoints — no access token, no refresh cookie. Enrolment is not optional
for a role that requires one: there is no session until it is done, because a
control everybody can defer is not a control.

**A code cannot be used twice.** The last accepted time step is recorded, so a
six-digit code read over somebody's shoulder is worth nothing for the rest of
its own thirty-second window.

**A wrong code costs the challenge, not the account.** Five attempts and the
challenge is spent; the account is untouched. Locking it would let anybody
holding a leaked password lock out the person who owns it — a denial of service
dressed as a control.

**The secret is encrypted, not hashed.** Verifying a code needs the secret back,
so a one-way function is not an option. AES-256-GCM under `MFA_SECRET_KEY`,
authenticated so a stored secret cannot be swapped for one an attacker holds.
Recovery codes _are_ hashed, and each works once.

**A required role cannot turn it off**, and a super admin can reset somebody who
lost their phone — which also revokes every session of theirs, since whoever
asked for the reset may be the person who found the phone.

`MFA_ENFORCEMENT` decides whether enrolment is forced. It ships as `required`.
The test environments run `optional`, which still verifies anybody already
enrolled but stops short of forcing enrolment — a TOTP code is single-use inside
its window, and a suite signing in dozens of times a minute cannot produce
distinct ones. The forced path has its own suite, which runs with it on.

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

**Phase 2 (onboarding and workforce)** — an accepted offer becomes a working
trainer in one transaction: a login, an employee code, a document checklist and a
project assignment. Documents are uploaded and verified (Aadhaar and PAN keep
only their last four characters), reminders go out at 24 and 72 hours with an
escalation to HR, and a trainer becomes active exactly when every mandatory
document is verified and they have somewhere to work. Screens: Running Projects,
the project roster, a trainer's profile, and the trainer's own My Profile.

**Phase 3 (delivery operations)** — a trainer's working day, and the decisions
it creates. Attendance is one punch pair a day, held by a unique index rather
than a check; location is recorded and never enforced, so a denied permission
still produces a valid punch. A nightly job closes the day, which is what makes
a correction reachable. Leave carries a per-assignment balance, escalates past
the lead after 24 hours, and writes the attendance days it covers. Alongside
those: the daily log (locked on save, unlocked only by an audited admin action),
deliverables, the asset register with serial reconciliation, reimbursements with
a two-tier approval limit, and flags. Screens: My Work (punch, attendance,
daily log, deliverables, resources), My Leave, My Reimbursements, the approver's
queue, and the Flags queue.

**Phase 4 (exit and re-use)** — a deboarding cannot complete while an issued
asset is unaccounted for or the settlement is open, and the refusal names the
specific items rather than only declining. The Talent Pool is a query, not a
table: completing a deboarding for somebody re-hire eligible puts them in it,
and revoking that eligibility takes them straight back out, with nobody setting
a flag. Plus role-shaped dashboards whose every number is counted through the
same scope as the list behind it, and CSV export on the major lists.

**Phase 5 (hardening and deployment)** — the permission matrix is executable:
the suite walks the running container and fails if any handler declares no
audience. That pass found a real hole — `GET /files/:id/download-url`
authorised nothing beyond "is signed in", and a Project Lead could open a
colleague's Aadhaar with an id the API had just handed them. Also: the Audit Log
and Users screens, Terraform for the whole estate, four runbooks, and the
browser suite in CI.

**Beyond the specification** — five capabilities the reference documents assumed
but never described, each built on request and each explained in its own section
above: the commercial side (clients, agreed day rates, and margin derived rather
than stored), skills and availability matching, the payroll input register, the
quality feedback loop, and document expiry. Then an information-architecture
pass, once the sidebar and the trainer profile had both outgrown a flat list:
six named sidebar sections and four groups of profile tabs, with empty groups
dropped rather than shown as bare headings. Then two more, each with its own
section above: operational messages to a trainer's phone over WhatsApp and SMS,
and a second factor for the roles that can read identity documents and pay.

Every screen in the specification is implemented; there are no placeholders.

| Suite                             | Count |
| --------------------------------- | ----- |
| Shared contracts                  | 252   |
| API integration (real PostgreSQL) | 752   |
| Browser (desktop + mobile)        | 168   |
