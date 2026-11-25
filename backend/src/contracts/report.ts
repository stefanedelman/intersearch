import { z } from "zod";

export const evidenceSchema = z.object({
	field: z.string().max(80),
	quote: z.string().min(1).max(400),
	sourceDocumentId: z.uuid(),
	url: z.string().max(2048),
});

export const sourceRefSchema = z.object({
	sourceDocumentId: z.uuid(),
	url: z.string().max(2048),
	title: z.string().max(500).nullable(),
	fetchedAt: z.string(),
});

export const breakdownSchema = z.object({
	role: z.number(),
	season: z.number(),
	location: z.number(),
	skills: z.number(),
	freshness: z.number(),
});

export const reportItemSchema = z.object({
	rank: z.number().int().min(1),
	section: z.enum(["new", "still", "returned"]),
	identityKey: z.string().max(400),
	company: z.string().max(120).nullable(),
	title: z.string().max(300),
	locations: z.array(z.string().max(200)).max(20),
	season: z.string().max(40).nullable(),
	score: z.number(),
	breakdown: breakdownSchema,
	summary: z.string().max(1000),
	fit: z.string().max(600),
	highlights: z.array(z.string().max(400)).max(5),
	agentNote: z.object({ quote: z.string().min(1).max(400) }).strict().nullable(),
	unknowns: z.array(z.string().max(40)).max(10),
	notes: z.array(z.string().max(300)).max(10),
	reverified: z.boolean(),
	applicationUrl: z.string().max(2048),
	postedAt: z.string().nullable(),
	firstSeenAt: z.string().nullable(),
	sources: z.array(sourceRefSchema).min(1).max(10),
	evidence: z.array(evidenceSchema).max(60),
});

export const droppedItemSchema = z.object({
	identityKey: z.string().max(400),
	company: z.string().max(120).nullable(),
	title: z.string().max(300),
	previousRank: z.number().int().nullable(),
	reason: z.string().max(400),
});

/** 1B tracker reports (schemaVersion 1). Kept readable: run-1 evidence and NYUgrader history use it. */
export const reportJsonV1Schema = z.object({
	schemaVersion: z.literal(1),
	runId: z.uuid(),
	status: z.enum(["complete", "partial", "failed"]),
	stopReason: z.string().max(400).nullable(),
	generatedAt: z.string(),
	topic: z.string().max(300),
	k: z.number().int(),
	season: z.string(),
	comparison: z.object({
		baselineRunId: z.uuid().nullable(),
		reset: z.boolean(),
		note: z.string().max(400).nullable(),
	}),
	items: z.array(reportItemSchema).max(10),
	dropped: z.array(droppedItemSchema).max(20),
	notes: z.array(z.string().max(400)).max(20),
	stats: z.object({
		fetched: z.number().int(),
		skipped: z.number().int(),
		rejected: z.number().int(),
		failed: z.number().int(),
		searches: z.number().int(),
		modelCalls: z.number().int(),
		inputTokens: z.number().int(),
		outputTokens: z.number().int(),
		searchCredits: z.number(),
		networkRequests: z.number().int(),
		elapsedMs: z.number().int(),
	}),
});

export type EvidenceRef = z.infer<typeof evidenceSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type ReportItemJson = z.infer<typeof reportItemSchema>;
export type DroppedItemJson = z.infer<typeof droppedItemSchema>;
export type ReportJsonV1 = z.infer<typeof reportJsonV1Schema>;

// ---------------------------------------------------------------------------------------------
// schemaVersion 2: orchestrated runs (Assignment 2). Written by the orchestrator only.
// ---------------------------------------------------------------------------------------------

export const claimLabels = ["supported", "unsupported", "unreachable", "unverified"] as const;
export type ClaimLabelValue = (typeof claimLabels)[number];
export const workerStatuses = ["complete", "partial", "failed", "skipped"] as const;

export const reportClaimSchema = z.object({
	claimId: z.string().max(64),
	text: z.string().max(500),
	sourceUrl: z.string().max(2048),
	label: z.enum(claimLabels),
	/** An excerpt of the fetched page (≤300 characters) on supported claims; null otherwise. */
	evidence: z.string().max(300).nullable(),
});

export const reportItemV2Schema = z.object({
	rank: z.number().int().min(1),
	section: z.enum(["new", "still", "returned"]),
	developmentId: z.string().max(400),
	title: z.string().max(300),
	summary: z.string().max(1000),
	claims: z.array(reportClaimSchema).max(12),
	/** True when the item is last run's, shown because the researcher failed this run. */
	stale: z.boolean(),
	/** When stale: the run the item comes from. */
	fromRunId: z.uuid().nullable(),
});

export const droppedItemV2Schema = z.object({
	developmentId: z.string().max(400),
	title: z.string().max(300),
	previousRank: z.number().int().nullable(),
	reason: z.string().max(400),
});

export const reportJsonV2Schema = z.object({
	schemaVersion: z.literal(2),
	runId: z.uuid(),
	status: z.enum(["complete", "partial", "failed"]),
	stopReason: z.string().max(400).nullable(),
	generatedAt: z.string(),
	topic: z.string().max(300),
	k: z.number().int(),
	/** The researcher failed: there are no new results and items are last run's top K. */
	stale: z.boolean(),
	failedWorkers: z.array(z.enum(["researcher", "verifier"])).max(2),
	workers: z.object({ researcher: z.enum(workerStatuses), verifier: z.enum(workerStatuses) }),
	comparison: z.object({ baselineRunId: z.uuid().nullable(), note: z.string().max(400).nullable() }),
	items: z.array(reportItemV2Schema).max(10),
	dropped: z.array(droppedItemV2Schema).max(20),
	notes: z.array(z.string().max(400)).max(20),
	stats: z.object({
		claims: z.object({ supported: z.number().int(), unsupported: z.number().int(), unreachable: z.number().int(), unverified: z.number().int() }),
		workerCalls: z.number().int(),
		elapsedMs: z.number().int(),
		/** Budget for the whole run: config total vs. what the orchestrator charged (each request_id once). */
		budget: z.object({
			total: z.object({ steps: z.number().int(), fetches: z.number().int(), tokens: z.number().int() }),
			charged: z.object({ steps: z.number().int(), fetches: z.number().int(), tokens: z.number().int() }),
		}),
	}),
});

export type ReportClaim = z.infer<typeof reportClaimSchema>;
export type ReportItemV2 = z.infer<typeof reportItemV2Schema>;
export type DroppedItemV2 = z.infer<typeof droppedItemV2Schema>;
export type ReportJsonV2 = z.infer<typeof reportJsonV2Schema>;

/** Any stored report. Readers switch on schemaVersion. */
export const reportJsonSchema = z.discriminatedUnion("schemaVersion", [reportJsonV1Schema, reportJsonV2Schema]);
export type ReportJson = z.infer<typeof reportJsonSchema>;
