import { z } from "zod";
import { evidenceSchema, reportJsonSchema, sourceRefSchema } from "./report";

export const MAX_DOCUMENT_CHARS = 60_000;

export const startRunBodySchema = z.object({
	idempotencyKey: z.string().min(8).max(100),
});

export const traceEventInputSchema = z.object({
	eventId: z.string().min(1).max(100),
	parentEventId: z.string().max(100).nullable(),
	step: z.number().int().min(0),
	category: z.enum(["run", "model", "tool", "http", "api", "budget"]),
	service: z.string().max(100).nullable(),
	tool: z.string().max(60).nullable(),
	arguments: z.unknown(),
	status: z.string().max(40),
	startedAt: z.string(),
	latencyMs: z.number().int().nullable(),
	inputTokens: z.number().int().nullable(),
	outputTokens: z.number().int().nullable(),
	searchCredits: z.number().nullable(),
	estimatedCost: z.number().nullable(),
	errorCode: z.string().max(80).nullable(),
	detail: z.unknown(),
});

export const documentInputSchema = z.object({
	id: z.uuid(),
	canonicalUrl: z.string().max(2048),
	finalUrl: z.string().max(2048),
	sourceKind: z.enum(["html", "json", "text"]),
	title: z.string().max(500).nullable(),
	text: z.string().max(MAX_DOCUMENT_CHARS),
	contentHash: z.string().length(64),
	httpStatus: z.number().int(),
	metadata: z.record(z.string(), z.unknown()).nullable().default(null),
	fetchedAt: z.string(),
});

export const fetchAttemptInputSchema = z.object({
	eventId: z.string().min(1).max(100),
	requestedUrl: z.string().max(4096),
	canonicalUrl: z.string().max(2048).nullable(),
	sourceDocumentId: z.uuid().nullable(),
	status: z.enum(["fetched", "skipped_seen", "rejected", "failed"]),
	reason: z.string().max(500).nullable(),
	title: z.string().max(500).nullable(),
	attemptedAt: z.string(),
	latencyMs: z.number().int().nullable(),
	bytes: z.number().int().nullable(),
	retryCount: z.number().int().min(0),
});

export const checkpointBodySchema = z.object({
	events: z.array(traceEventInputSchema).max(500).default([]),
	documents: z.array(documentInputSchema).max(40).default([]),
	fetchAttempts: z.array(fetchAttemptInputSchema).max(200).default([]),
});

export const observationInputSchema = z.object({
	identityKey: z.string().min(1).max(400),
	identityMethod: z.enum(["provider_id", "title_location_season"]),
	providerJobId: z.string().max(100).nullable(),
	companyId: z.string().max(40).nullable(),
	companyName: z.string().max(120),
	title: z.string().max(300),
	normalizedTitle: z.string().max(300),
	locationKey: z.string().max(400).nullable(),
	season: z.string().max(40).nullable(),
	applicationUrl: z.string().max(2048).nullable(),
	facts: z.record(z.string(), z.unknown()),
	evidence: z.array(evidenceSchema).max(80),
	sourceDocumentIds: z.array(z.uuid()).min(1).max(10),
	reverified: z.boolean(),
});

export const finalizeBodySchema = z.object({
	status: z.enum(["complete", "partial", "failed"]),
	stopReason: z.string().max(500).nullable(),
	errorCode: z.string().max(80).nullable(),
	budgetTotals: z.record(z.string(), z.number()),
	report: reportJsonSchema,
	markdown: z.string().max(200_000),
	observations: z.array(observationInputSchema).max(300),
});

export type StartRunBody = z.infer<typeof startRunBodySchema>;
export type TraceEventInput = z.infer<typeof traceEventInputSchema>;
export type DocumentInput = z.infer<typeof documentInputSchema>;
export type FetchAttemptInput = z.infer<typeof fetchAttemptInputSchema>;
export type CheckpointBody = z.infer<typeof checkpointBodySchema>;
export type ObservationInput = z.infer<typeof observationInputSchema>;
export type FinalizeBody = z.infer<typeof finalizeBodySchema>;

/** Saved state the tracker loads at the start of a run. */
export type TrackerStateDto = {
	trackerId: string;
	comparisonKey: string | null;
	comparisonReset: boolean;
	baseline: { runId: string; items: { identityKey: string; rank: number | null; company: string | null; title: string }[] } | null;
	documents: { id: string; canonicalUrl: string; title: string | null; fetchedAt: string; contentHash: string }[];
	opportunities: {
		id: string;
		identityKey: string;
		companyName: string;
		title: string;
		providerJobId: string | null;
		firstSeenAt: string;
		lastSeenAt: string;
		firstReportedAt: string | null;
		lastObservation: { facts: Record<string, unknown>; evidence: z.infer<typeof evidenceSchema>[]; sources: z.infer<typeof sourceRefSchema>[] } | null;
	}[];
};

export type StartRunResponse = {
	runId: string;
	status: "running";
	baselineRunId: string | null;
	abandonedRunIds: string[];
};
