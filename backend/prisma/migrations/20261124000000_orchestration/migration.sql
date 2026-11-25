-- Assignment 2 (agentic orchestration). Additive only: new columns with defaults and new tables.
-- Nothing is dropped or rewritten, so 1B runs, reports, and the NYUgrader history are untouched.
-- CreateEnum
CREATE TYPE "ClaimLabel" AS ENUM ('supported', 'unsupported', 'unreachable', 'unverified');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failedWorkers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'tracker',
ADD COLUMN     "ledger" JSONB,
ADD COLUMN     "phase" TEXT,
ADD COLUMN     "stale" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WorkerCall" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "finalStatus" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "share" JSONB NOT NULL,
    "reportedUsage" JSONB,
    "chargedUsage" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptLog" JSONB,

    CONSTRAINT "WorkerCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "reportItemId" UUID,
    "developmentId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "label" "ClaimLabel" NOT NULL,
    "evidence" TEXT,
    "verifyRequestId" UUID,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkerCall_requestId_key" ON "WorkerCall"("requestId");

-- CreateIndex
CREATE INDEX "WorkerCall_runId_startedAt_idx" ON "WorkerCall"("runId", "startedAt");

-- CreateIndex
CREATE INDEX "Claim_runId_developmentId_idx" ON "Claim"("runId", "developmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_runId_claimId_key" ON "Claim"("runId", "claimId");

-- AddForeignKey
ALTER TABLE "WorkerCall" ADD CONSTRAINT "WorkerCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_reportItemId_fkey" FOREIGN KEY ("reportItemId") REFERENCES "ReportItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Same rule as 20260928000001_enable_rls: no Supabase Data API access to app tables.
ALTER TABLE "WorkerCall" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Claim" ENABLE ROW LEVEL SECURITY;
