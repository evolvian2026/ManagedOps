-- Reaching people on their phone, and knowing whether we did.
--
-- Three things happen here. Every phone number already stored is normalised to
-- one canonical form; a constraint keeps it that way; and every attempt to
-- reach a phone becomes a row, because "did the trainer get the reminder?" is a
-- question that gets asked about leave decisions and document deadlines.

-- ---------------------------------------------------------------- normalise

-- The same rule `normaliseIndianMobile` applies in the application, expressed
-- once in SQL for the rows that predate it: drop the punctuation people type,
-- drop a country code or a trunk zero, then put exactly one +91 back on.
CREATE OR REPLACE FUNCTION managedops_normalise_mobile(raw TEXT) RETURNS TEXT AS $$
DECLARE
  bare TEXT;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN NULL; END IF;
  bare := regexp_replace(raw, '[\s\-()./]', '', 'g');
  IF bare LIKE '+91%' THEN
    bare := substring(bare FROM 4);
  ELSIF length(bare) = 12 AND bare LIKE '91%' THEN
    bare := substring(bare FROM 3);
  ELSIF length(bare) = 11 AND bare LIKE '0%' THEN
    bare := substring(bare FROM 2);
  END IF;
  IF bare ~ '^[6-9][0-9]{9}$' THEN RETURN '+91' || bare; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE "users" SET "phone" = managedops_normalise_mobile("phone") WHERE "phone" IS NOT NULL;
UPDATE "candidates" SET "phone" = managedops_normalise_mobile("phone");
UPDATE "trainers" SET "phone" = managedops_normalise_mobile("phone");
UPDATE "clients" SET "contactPhone" = managedops_normalise_mobile("contactPhone")
  WHERE "contactPhone" IS NOT NULL;

-- A trainer's number was captured against their trainer record; the messaging
-- layer reads the user, so the two are reconciled here and kept in step by the
-- application from now on. One number per person, in one place to look.
UPDATE "users" u
   SET "phone" = t."phone"
  FROM "trainers" t
 WHERE t."userId" = u."id" AND u."phone" IS NULL AND t."phone" IS NOT NULL;

-- `phone` is already required on a trainer and a candidate, so a number that
-- will not normalise makes the update above fail on the NOT NULL rather than
-- quietly storing something nothing can send to. That is the intended
-- behaviour: a bad number is a data problem to look at, not one to inherit.

-- E.164, and an Indian mobile series. The application normalises on the way in;
-- this is what makes that a guarantee rather than a habit, so nothing below the
-- messaging layer has to re-parse a number before sending to it.
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164"
    CHECK ("phone" IS NULL OR "phone" ~ '^\+91[6-9][0-9]{9}$');
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_phone_e164"
    CHECK ("phone" ~ '^\+91[6-9][0-9]{9}$');
ALTER TABLE "trainers" ADD CONSTRAINT "trainers_phone_e164"
    CHECK ("phone" ~ '^\+91[6-9][0-9]{9}$');
ALTER TABLE "clients" ADD CONSTRAINT "clients_contact_phone_e164"
    CHECK ("contactPhone" IS NULL OR "contactPhone" ~ '^\+91[6-9][0-9]{9}$');

DROP FUNCTION managedops_normalise_mobile(TEXT);

-- ---------------------------------------------------------------- opt-out

-- Default on, because every message the catalogue carries is one the person
-- needs. Turning it off is theirs to decide, not a setting to be defaulted
-- into silence.
ALTER TABLE "users" ADD COLUMN "mobileNotifications" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- deliveries

CREATE TYPE "MobileChannel" AS ENUM ('whatsapp', 'sms');
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('sent', 'failed', 'skipped');

CREATE TABLE "message_deliveries" (
    "id"                TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "channel"           "MobileChannel" NOT NULL,
    "status"            "MessageDeliveryStatus" NOT NULL,
    "template"          TEXT NOT NULL,
    "toMasked"          TEXT NOT NULL,
    "providerMessageId" TEXT,
    "error"             TEXT,
    "notificationType"  TEXT NOT NULL,
    "entityType"        TEXT,
    "entityId"          TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "message_deliveries_userId_createdAt_idx"
    ON "message_deliveries"("userId", "createdAt" DESC);
CREATE INDEX "message_deliveries_status_createdAt_idx"
    ON "message_deliveries"("status", "createdAt");

-- A number is never stored here in full: the contact record is on the user, and
-- a log queried daily has no reason to hold every mobile number in the company.
-- Expressed as "no run of five or more digits", which a ten-digit number cannot
-- satisfy, so the guarantee survives a change to how the mask is formatted.
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_to_masked"
    CHECK ("toMasked" LIKE '%•%' AND "toMasked" !~ '[0-9]{5}');
