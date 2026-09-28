import { api } from "./client";

export type Section = "new" | "still" | "returned";

export type SourceRef = { sourceDocumentId: string; url: string; title: string | null; fetchedAt: string };
export type Evidence = { field: string; quote: string; sourceDocumentId: string; url: string };

export type ReportItem = {
	rank: number;
	section: Section;
	identityKey: string;
	company: string | null;
	title: string;
	locations: string[];
	season: string | null;
	score: number;
	breakdown: { role: number; season: number; location: number; skills: number; freshness: number };
	summary: string;
	fit: string;
	highlights: string[];
	agentNote: { reason: string; quote: string } | null;
	unknowns: string[];
	notes: string[];
	reverified: boolean;
	applicationUrl: string;
	postedAt: string | null;
	firstSeenAt: string | null;
	sources: SourceRef[];
	evidence: Evidence[];
};

export type DroppedItem = { identityKey: string; company: string | null; title: string; previousRank: number | null; reason: string };

export type Report = {
	schemaVersion: 1;
	runId: string;
	status: "complete" | "partial" | "failed";
	stopReason: string | null;
	generatedAt: string;
	topic: string;
	k: number;
	season: string;
	comparison: { baselineRunId: string | null; reset: boolean; note: string | null };
	items: ReportItem[];
	dropped: DroppedItem[];
	notes: string[];
	stats: {
		fetched: number;
		skipped: number;
		rejected: number;
		failed: number;
		searches: number;
		modelCalls: number;
		inputTokens: number;
		outputTokens: number;
		searchCredits: number;
		networkRequests: number;
		elapsedMs: number;
	};
};

export type RunStatus = "running" | "complete" | "partial" | "failed";

export type RunSummary = {
	id: string;
	status: RunStatus;
	startedAt: string;
	finishedAt: string | null;
	lastEventAt: string;
	stopReason: string | null;
	errorCode: string | null;
	partial: boolean;
	baselineRunId: string | null;
	hasReport: boolean;
	counts: { new: number; still: number; returned: number; dropped: number };
	budgetTotals: Record<string, number> | null;
	configHash: string;
};

export type TrackerConfigView = {
	tracker: { name: string; topic: string; k: number; season: string };
	preferences: { roles: string[]; locations: string[]; remote_allowed: boolean; remote_region: string | null; skills: string[] };
	model: { provider: string; id: string };
	limits: Record<string, number>;
	allowedHosts: string[];
	companies: { id: string; name: string; careersUrl: string }[];
};

export type TrackerOverview = {
	tracker: { id: string; name: string; config: TrackerConfigView | null; configHash: string | null; updatedAt: string };
	runInProgress: { id: string; startedAt: string; lastEventAt: string } | null;
	latestRun: RunSummary | null;
};

export type SourceAttempt = {
	id: string;
	requestedUrl: string;
	canonicalUrl: string | null;
	finalUrl: string | null;
	title: string | null;
	status: "fetched" | "skipped_seen" | "rejected" | "failed";
	reason: string | null;
	attemptedAt: string;
	fetchedAt: string | null;
	latencyMs: number | null;
	bytes: number | null;
	retryCount: number;
};

export type TraceEvent = {
	id: string;
	eventId: string;
	parentEventId: string | null;
	step: number;
	category: string;
	service: string | null;
	tool: string | null;
	arguments: unknown;
	status: string;
	startedAt: string;
	latencyMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	searchCredits: number | null;
	errorCode: string | null;
	detail: unknown;
};

export const trackerApi = {
	overview: () => api<TrackerOverview>("/api/tracker"),
	latestReport: () => api<{ run: RunSummary | null; report: Report | null }>("/api/tracker/report/latest"),
	runs: (cursor?: string) => api<{ runs: RunSummary[]; nextCursor: string | null }>(`/api/tracker/runs?limit=20${cursor ? `&cursor=${cursor}` : ""}`),
	run: (id: string) => api<{ run: RunSummary & { config: TrackerConfigView | null; attemptCounts: Record<string, number> } }>(`/api/tracker/runs/${encodeURIComponent(id)}`),
	report: (id: string) => api<{ report: Report; markdown: string; status: string; createdAt: string }>(`/api/tracker/runs/${encodeURIComponent(id)}/report`),
	sources: (id: string, cursor?: string) => api<{ sources: SourceAttempt[]; nextCursor: string | null }>(`/api/tracker/runs/${encodeURIComponent(id)}/sources?limit=200${cursor ? `&cursor=${cursor}` : ""}`),
	trace: (id: string, cursor?: string) => api<{ events: TraceEvent[]; nextCursor: string | null }>(`/api/tracker/runs/${encodeURIComponent(id)}/trace?limit=200${cursor ? `&cursor=${cursor}` : ""}`),
};

/** Only http(s) URLs become links; anything else (javascript:, data:) is shown as plain text. */
export function safeHref(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
	} catch {
		return null;
	}
}

export function formatDateTime(value: string | null | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return "—";
	if (ms < 1000) return `${ms} ms`;
	const seconds = ms / 1000;
	return seconds < 90 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
