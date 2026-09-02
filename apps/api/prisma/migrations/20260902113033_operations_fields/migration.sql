-- AlterTable
ALTER TABLE "reimbursements" ADD COLUMN     "paymentReference" TEXT;

-- AlterTable
ALTER TABLE "trainers" ADD COLUMN     "locationConsentAt" TIMESTAMP(3);
