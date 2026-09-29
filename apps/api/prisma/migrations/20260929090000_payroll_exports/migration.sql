-- A record of every month handed to payroll.
--
-- The register is computed live, which is honest but means a file exported on
-- the 3rd can quietly stop matching by the 5th. Keeping the digest of what went
-- out is what lets the screen say "these figures have moved since you sent
-- them" rather than leaving somebody to find out at the next payday.

CREATE TABLE "payroll_exports" (
    "id"             TEXT NOT NULL,
    "month"          TEXT NOT NULL,
    "layout"         TEXT NOT NULL,
    "rowCount"       INTEGER NOT NULL,
    "totalPayable"   DECIMAL(14,2) NOT NULL,
    "figuresDigest"  TEXT NOT NULL,
    "forced"         BOOLEAN NOT NULL DEFAULT false,
    "unresolvedRows" INTEGER NOT NULL DEFAULT 0,
    "exportedById"   TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_exports_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payroll_exports" ADD CONSTRAINT "payroll_exports_exportedById_fkey"
    FOREIGN KEY ("exportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The screen asks one question of this table — "what was the last export of
-- this month?" — so that is the index it gets.
CREATE INDEX "payroll_exports_month_createdAt_idx"
    ON "payroll_exports"("month", "createdAt" DESC);

-- A payroll period is a calendar month and nothing else. A row claiming to be
-- a fortnight would be a register that was run over the wrong range.
ALTER TABLE "payroll_exports" ADD CONSTRAINT "payroll_exports_month_format"
    CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- A negative headcount, or a forced export that resolved nothing, are both
-- shapes of "the recording is wrong", and a wrong record is worse than none.
ALTER TABLE "payroll_exports" ADD CONSTRAINT "payroll_exports_counts_sane"
    CHECK ("rowCount" >= 0 AND "unresolvedRows" >= 0 AND "unresolvedRows" <= "rowCount");

-- Only a forced export can have carried unresolved rows; the ordinary path
-- refuses them outright, so a row saying otherwise means the guard was bypassed.
ALTER TABLE "payroll_exports" ADD CONSTRAINT "payroll_exports_unresolved_only_when_forced"
    CHECK ("forced" OR "unresolvedRows" = 0);
