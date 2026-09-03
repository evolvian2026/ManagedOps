-- Clients become records rather than a string on the project, and an assignment
-- carries what the client pays for it.
--
-- The interesting part is the backfill. Projects already name their clients in
-- free text, so this derives one client per distinct name, points every project
-- at the right one, and only then drops the column. Doing it in that order means
-- no project is ever without a client and nothing has to be re-entered by hand.

CREATE TYPE "ClientStatus" AS ENUM ('active', 'inactive');

CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "billingAddress" TEXT,
    "gstin" TEXT,
    "defaultDayRate" DECIMAL(10,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clients_code_key" ON "clients"("code");
CREATE INDEX "clients_status_idx" ON "clients"("status");
CREATE INDEX "clients_deletedAt_idx" ON "clients"("deletedAt");

-- One client per distinct name already in use. The code is derived from the
-- name and de-duplicated with a counter, because it carries a unique index.
INSERT INTO "clients" ("id", "name", "code", "status", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    source."clientName",
    source."code",
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        "clientName",
        CASE WHEN ROW_NUMBER() OVER (PARTITION BY derived.base ORDER BY derived."clientName") = 1
             THEN derived.base
             ELSE derived.base || '-' || ROW_NUMBER() OVER (PARTITION BY derived.base ORDER BY derived."clientName")
        END AS "code"
    FROM (
        SELECT DISTINCT
            "clientName",
            COALESCE(NULLIF(UPPER(LEFT(REGEXP_REPLACE("clientName", '[^A-Za-z0-9]', '', 'g'), 12)), ''), 'CLIENT') AS base
        FROM "projects"
    ) AS derived
) AS source;

ALTER TABLE "projects" ADD COLUMN "clientId" TEXT;

UPDATE "projects" p
SET "clientId" = c."id"
FROM "clients" c
WHERE c."name" = p."clientName";

ALTER TABLE "projects" ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "projects" DROP COLUMN "clientName";

CREATE INDEX "projects_clientId_idx" ON "projects"("clientId");
ALTER TABLE "projects" ADD CONSTRAINT "projects_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignments" ADD COLUMN "billRatePerDay" DECIMAL(10,2);
