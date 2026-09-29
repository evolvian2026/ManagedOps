-- Recording that an assignment is deliberately not billed.
--
-- A null day rate carried two meanings that could not be less alike to act on:
-- internal work that will never be billed, and a rate nobody has agreed yet.
-- The first is finished business; the second is money going uncollected. With
-- both looking identical in the data, the margin screen had to warn about every
-- unrated assignment forever — including the deliberate ones — and a warning
-- that can never be cleared is one people stop reading.

ALTER TABLE "assignments" ADD COLUMN "notBilledReason" TEXT;
ALTER TABLE "assignments" ADD COLUMN "notBilledAt"     TIMESTAMP(3);
ALTER TABLE "assignments" ADD COLUMN "notBilledById"   TEXT;

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_notBilledById_fkey"
    FOREIGN KEY ("notBilledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A rate and a decision not to bill are contradictory answers to one question.
-- Enforced here rather than only in the service: the invariant is about what a
-- row may mean, and a row that means two things is not recoverable later.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_rate_or_not_billed"
    CHECK (NOT ("billRatePerDay" IS NOT NULL AND "notBilledReason" IS NOT NULL));

-- The decision is only a decision if somebody made it, at a time. A reason
-- standing on its own is an import artefact, not an accountable choice.
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_not_billed_is_attributed"
    CHECK (("notBilledReason" IS NULL) = ("notBilledAt" IS NULL));

-- The margin screen's one question of this column: which assignments are still
-- undecided? Partial, because the decided ones are the majority and never match.
CREATE INDEX "assignments_undecided_billing_idx"
    ON "assignments"("projectId")
    WHERE "billRatePerDay" IS NULL AND "notBilledReason" IS NULL;
