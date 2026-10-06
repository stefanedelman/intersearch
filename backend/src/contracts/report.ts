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

export const reportJsonSchema = z.object({
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
export type ReportJson = z.infer<typeof reportJsonSchema>;
