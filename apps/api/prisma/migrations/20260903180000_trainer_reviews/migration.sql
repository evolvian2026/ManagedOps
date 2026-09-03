-- What delivery was actually like, recorded against the engagement it happened
-- on. This is the evidence a re-hire decision has been made without until now.
--
-- Append-only by construction: there is no updated_at and the service offers no
-- update. A review that turns out to be wrong is retracted with a reason and
-- stays visible as retracted, because a performance record anybody can quietly
-- rewrite is worth much less than one they cannot.

CREATE TYPE "ReviewSource" AS ENUM ('learner_batch', 'client', 'internal_observation');

CREATE TABLE "trainer_reviews" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "source" "ReviewSource" NOT NULL,
    "rating" INTEGER NOT NULL,
    "knowledge" INTEGER,
    "delivery" INTEGER,
    "professionalism" INTEGER,
    "respondents" INTEGER,
    "comment" TEXT,
    "observedOn" DATE NOT NULL,
    "submittedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retractedAt" TIMESTAMP(3),
    "retractedById" TEXT,
    "retractedReason" TEXT,

    CONSTRAINT "trainer_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trainer_reviews_assignmentId_observedOn_idx"
    ON "trainer_reviews"("assignmentId", "observedOn" DESC);
CREATE INDEX "trainer_reviews_source_observedOn_idx"
    ON "trainer_reviews"("source", "observedOn");

ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_retractedById_fkey"
    FOREIGN KEY ("retractedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ratings are a one-to-five scale, enforced where it cannot be bypassed. A
-- zero or a seven arriving through any path is a bug, not a low score.
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_rating_range"
    CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_dimension_ranges"
    CHECK (
        ("knowledge" IS NULL OR "knowledge" BETWEEN 1 AND 5)
        AND ("delivery" IS NULL OR "delivery" BETWEEN 1 AND 5)
        AND ("professionalism" IS NULL OR "professionalism" BETWEEN 1 AND 5)
    );

-- A cohort of nobody is not a cohort. Null means "one person speaking for
-- themselves"; zero or negative is meaningless and would divide a weighted
-- average by nothing.
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_respondents_positive"
    CHECK ("respondents" IS NULL OR "respondents" > 0);

-- A retraction is all three fields or none of them: a row marked withdrawn
-- with no reason and nobody's name against it is worse than not withdrawn.
ALTER TABLE "trainer_reviews" ADD CONSTRAINT "trainer_reviews_retraction_complete"
    CHECK (
        ("retractedAt" IS NULL AND "retractedById" IS NULL AND "retractedReason" IS NULL)
        OR ("retractedAt" IS NOT NULL AND "retractedById" IS NOT NULL AND "retractedReason" IS NOT NULL)
    );
