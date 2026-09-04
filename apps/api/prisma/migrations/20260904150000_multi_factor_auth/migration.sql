-- A second factor for the accounts that can read identity documents and pay.
--
-- Which roles those are is not decided here — it is derived from the permission
-- matrix in the shared package, on scope rather than on holding a capability at
-- all, so a project lead reading their own payslip is not dragged in alongside
-- HR reading everybody's.

-- The TOTP secret cannot be hashed the way a password is: verifying a code
-- needs the secret back. It is encrypted instead, under a key that lives in the
-- environment rather than the database, so a dump of this table alone does not
-- let anybody mint codes.
ALTER TABLE "users" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "users" ADD COLUMN "mfaEnrolledAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "mfaLastUsedStep" BIGINT;

-- An enrolment that was started and walked away from is not a second factor.
-- Enrolled without a secret would be exactly that, and would let somebody past
-- the verify step with nothing to verify against.
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_enrolled_has_secret"
    CHECK ("mfaEnrolledAt" IS NULL OR "mfaSecret" IS NOT NULL);

CREATE TABLE "mfa_recovery_codes" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "codeHash"  TEXT NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_recovery_codes_codeHash_key" ON "mfa_recovery_codes"("codeHash");
CREATE INDEX "mfa_recovery_codes_userId_usedAt_idx" ON "mfa_recovery_codes"("userId", "usedAt");

ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mfa_challenges" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "enrolling"  BOOLEAN NOT NULL DEFAULT false,
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_challenges_tokenHash_key" ON "mfa_challenges"("tokenHash");
CREATE INDEX "mfa_challenges_userId_expiresAt_idx" ON "mfa_challenges"("userId", "expiresAt");
CREATE INDEX "mfa_challenges_expiresAt_idx" ON "mfa_challenges"("expiresAt");

ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The attempt counter is what stops a six-digit code being guessed. A negative
-- count would mean something is decrementing it, which is the shape a bypass
-- takes.
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_attempts_positive"
    CHECK ("attempts" >= 0);
