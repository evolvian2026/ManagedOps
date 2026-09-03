-- A canonical skill catalogue, what a trainer can teach, what a position needs,
-- and how much of a trainer's time an assignment actually takes.
--
-- The last of those is what makes "who is free" answerable, and it comes with
-- the two constraints below — including one the application has been claiming
-- in a comment while enforcing nothing.

CREATE TYPE "Proficiency" AS ENUM ('beginner', 'intermediate', 'advanced', 'expert');
CREATE TYPE "SkillRequirement" AS ENUM ('essential', 'desirable');
CREATE TYPE "SkillStatus" AS ENUM ('active', 'archived');

CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "status" "SkillStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");
CREATE INDEX "skills_status_name_idx" ON "skills"("status", "name");

CREATE TABLE "trainer_skills" (
    "id" TEXT NOT NULL,
    "trainerId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "proficiency" "Proficiency" NOT NULL DEFAULT 'intermediate',
    "years" DECIMAL(4,1),
    "lastUsedOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "trainer_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trainer_skills_trainerId_skillId_key" ON "trainer_skills"("trainerId", "skillId");
CREATE INDEX "trainer_skills_skillId_proficiency_idx" ON "trainer_skills"("skillId", "proficiency");

ALTER TABLE "trainer_skills" ADD CONSTRAINT "trainer_skills_trainerId_fkey"
    FOREIGN KEY ("trainerId") REFERENCES "trainers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trainer_skills" ADD CONSTRAINT "trainer_skills_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "position_skills" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "requirement" "SkillRequirement" NOT NULL DEFAULT 'essential',
    "minProficiency" "Proficiency",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "position_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "position_skills_positionId_skillId_key" ON "position_skills"("positionId", "skillId");
CREATE INDEX "position_skills_skillId_idx" ON "position_skills"("skillId");

ALTER TABLE "position_skills" ADD CONSTRAINT "position_skills_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "position_skills" ADD CONSTRAINT "position_skills_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Capacity. 100 is the existing behaviour: deployed to one client, full time.
ALTER TABLE "assignments" ADD COLUMN "allocationPercent" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_allocation_within_range"
    CHECK ("allocationPercent" > 0 AND "allocationPercent" <= 100);

-- The index the service has been claiming in a comment for two phases.
--
-- `assignments.service.ts` says a partial unique index makes a duplicate live
-- assignment "impossible at the storage layer", and that its own check merely
-- explains the refusal. No such index was ever created, so the only guard was
-- a read followed by a write — which two concurrent requests both pass.
CREATE UNIQUE INDEX "assignments_one_live_per_project"
    ON "assignments" ("trainerId", "projectId")
    WHERE "status" = 'active' AND "deletedAt" IS NULL;

-- No trainer is in two places at once.
--
-- Enforced only between assignments that each claim the whole of somebody's
-- time, because that is the case with an unambiguous answer. Ranges are
-- half-open and an open-ended assignment runs to infinity, so an indefinite
-- posting blocks every later one until it is given an end date — which is the
-- honest reading of "we do not know when they are free again".
--
-- Deliberately not a rule about partial allocations summing to 100: no
-- exclusion constraint can express a sum, and pretending otherwise in SQL
-- would be worse than checking it where it can actually be checked.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "assignments" ADD CONSTRAINT "assignments_no_full_time_overlap"
    EXCLUDE USING gist (
        "trainerId" WITH =,
        daterange("startDate", COALESCE("endDate" + 1, 'infinity'::date), '[)') WITH &&
    )
    WHERE ("status" = 'active' AND "allocationPercent" = 100 AND "deletedAt" IS NULL);
