-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'complete', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "FetchStatus" AS ENUM ('fetched', 'skipped_seen', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "ReportSection" AS ENUM ('new', 'still', 'returned', 'dropped');

-- CreateTable
CREATE TABLE "Profile" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "normalizedUsername" TEXT NOT NULL,
    "hasRealEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tracker" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Intersearch',
    "activeConfig" JSONB,
    "configHash" TEXT,
    "comparisonKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanySource" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "careersUrl" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "boardToken" TEXT,
    "allowedHosts" JSONB NOT NULL,
    "permissionNotes" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CompanySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "configSnapshot" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "comparisonKey" TEXT NOT NULL,
    "baselineRunId" UUID,
    "stopReason" TEXT,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "budgetTotals" JSONB,
    "errorCode" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "finalUrl" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "metadata" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FetchAttempt" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "requestedUrl" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "sourceDocumentId" UUID,
    "status" "FetchStatus" NOT NULL,
    "reason" TEXT,
    "title" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latencyMs" INTEGER,
    "bytes" INTEGER,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FetchAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" UUID NOT NULL,
    "trackerId" UUID NOT NULL,
    "identityKey" TEXT NOT NULL,
    "companySourceId" UUID,
    "companyName" TEXT NOT NULL,
    "provider" TEXT,
    "providerJobId" TEXT,
    "internalJobId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "locationKey" TEXT,
    "season" TEXT,
    "applicationUrl" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstReportedAt" TIMESTAMP(3),

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityObservation" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "extractedFacts" JSONB NOT NULL,
    "evidenceReferences" JSONB NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunitySource" (
    "opportunityId" UUID NOT NULL,
    "sourceDocumentId" UUID NOT NULL,
    "relation" TEXT NOT NULL,
    "dedupeMethod" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "OpportunitySource_pkey" PRIMARY KEY ("opportunityId","sourceDocumentId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "RunStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportJson" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "previousCompleteRunId" UUID,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportItem" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "rank" INTEGER,
    "section" "ReportSection" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "scoreBreakdown" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "evidenceReferences" JSONB NOT NULL,

    CONSTRAINT "ReportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "parentEventId" TEXT,
    "step" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "service" TEXT,
    "tool" TEXT,
    "argumentsRedacted" JSONB,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "searchCredits" DOUBLE PRECISION,
    "estimatedCost" DOUBLE PRECISION,
    "errorCode" TEXT,
    "detail" JSONB,

    CONSTRAINT "TraceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Profile_normalizedUsername_key" ON "Profile"("normalizedUsername");

-- CreateIndex
CREATE UNIQUE INDEX "Tracker_profileId_key" ON "Tracker"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanySource_trackerId_key_key" ON "CompanySource"("trackerId", "key");

-- CreateIndex
CREATE INDEX "Run_trackerId_startedAt_idx" ON "Run"("trackerId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Run_trackerId_idempotencyKey_key" ON "Run"("trackerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SourceDocument_trackerId_canonicalUrl_idx" ON "SourceDocument"("trackerId", "canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_trackerId_canonicalUrl_contentHash_key" ON "SourceDocument"("trackerId", "canonicalUrl", "contentHash");

-- CreateIndex
CREATE INDEX "FetchAttempt_runId_attemptedAt_idx" ON "FetchAttempt"("runId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FetchAttempt_runId_eventId_key" ON "FetchAttempt"("runId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_trackerId_identityKey_key" ON "Opportunity"("trackerId", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityObservation_runId_opportunityId_key" ON "OpportunityObservation"("runId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_runId_key" ON "Report"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportItem_reportId_opportunityId_key" ON "ReportItem"("reportId", "opportunityId");

-- CreateIndex
CREATE INDEX "TraceEvent_runId_step_idx" ON "TraceEvent"("runId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "TraceEvent_runId_eventId_key" ON "TraceEvent"("runId", "eventId");

-- AddForeignKey
ALTER TABLE "Tracker" ADD CONSTRAINT "Tracker_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanySource" ADD CONSTRAINT "CompanySource_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "Tracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "Tracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "Tracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchAttempt" ADD CONSTRAINT "FetchAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FetchAttempt" ADD CONSTRAINT "FetchAttempt_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "Tracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companySourceId_fkey" FOREIGN KEY ("companySourceId") REFERENCES "CompanySource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityObservation" ADD CONSTRAINT "OpportunityObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityObservation" ADD CONSTRAINT "OpportunityObservation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySource" ADD CONSTRAINT "OpportunitySource_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunitySource" ADD CONSTRAINT "OpportunitySource_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportItem" ADD CONSTRAINT "ReportItem_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportItem" ADD CONSTRAINT "ReportItem_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceEvent" ADD CONSTRAINT "TraceEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

