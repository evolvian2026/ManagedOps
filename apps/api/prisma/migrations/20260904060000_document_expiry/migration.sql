-- Documents that lapse, and the date they lapse on.
--
-- The type list gains the two that actually expire. Aadhaar, PAN and a degree
-- certificate do not, which is why the column is nullable rather than required
-- — but a police verification with no date recorded is a gap to chase, not a
-- document that is valid forever, and the validity rules say so.

ALTER TYPE "TrainerDocumentType" ADD VALUE 'police_verification';
ALTER TYPE "TrainerDocumentType" ADD VALUE 'medical_certificate';

ALTER TABLE "trainer_documents" ADD COLUMN "expiresOn" DATE;
ALTER TABLE "trainer_documents" ADD COLUMN "expiryReminderStage" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "trainer_documents_expiresOn_idx" ON "trainer_documents"("expiresOn");

-- A reminder stage is one of the three the job knows about. A four arriving
-- through any path means the job has drifted from the column.
ALTER TABLE "trainer_documents" ADD CONSTRAINT "trainer_documents_reminder_stage_range"
    CHECK ("expiryReminderStage" BETWEEN 0 AND 2);
