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
	agentNote: { quote: string } | null;
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

/** 1B tracker reports (schemaVersion 1). */
export type ReportV1 = {
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

// ---------- schemaVersion 2: orchestrated runs (researcher + verifier) ----------

export type ClaimLabel = "supported" | "unsupported" | "unreachable" | "unverified";
export const CLAIM_LABELS: ClaimLabel[] = ["supported", "unsupported", "unreachable", "unverified"];
export type ClaimCounts = Record<ClaimLabel, number>;
export type WorkerName = "researcher" | "verifier";
export type WorkerState = "complete" | "partial" | "failed" | "skipped";

export type ReportClaim = { claimId: string; text: string; sourceUrl: string; label: ClaimLabel; evidence: string | null };

export type ReportItemV2 = {
	rank: number;
	section: Section;
	developmentId: string;
	title: string;
	summary: string;
	claims: ReportClaim[];
	stale: boolean;
	fromRunId: string | null;
};

export type DroppedItemV2 = { developmentId: string; title: string; previousRank: number | null; reason: string };

type Dimensions = { steps: number; fetches: number; tokens: number };

export type ReportV2 = {
	schemaVersion: 2;
	runId: string;
	status: "complete" | "partial" | "failed";
	stopReason: string | null;
	generatedAt: string;
	topic: string;
	k: number;
	stale: boolean;
	failedWorkers: WorkerName[];
	workers: Record<WorkerName, WorkerState>;
	comparison: { baselineRunId: string | null; note: string | null };
	items: ReportItemV2[];
	dropped: DroppedItemV2[];
	notes: string[];
	stats: { claims: ClaimCounts; workerCalls: number; elapsedMs: number; budget: { total: Dimensions; charged: Dimensions } };
};

export type Report = ReportV1 | ReportV2;

export type RunStatus = "running" | "complete" | "partial" | "failed";
export type RunPhase = "starting" | "researching" | "verifying" | "reporting" | "done";

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
	/** "tracker": a 1B CLI run; "orchestrated": researcher + verifier. */
	kind: "tracker" | "orchestrated";
	phase: RunPhase | null;
	failedWorkers: WorkerName[];
	stale: boolean;
	cancelRequested: boolean;
	claimCounts: ClaimCounts | null;
};

export type AttemptRecord = { attempt: number; startedAt: string; status: number | string; latencyMs: number; waitMs: number | null; retryAfterMs: number | null; errorCode: string | null };

export type WorkerCall = {
	requestId: string;
	service: WorkerName;
	endpoint: string;
	attempts: number;
	finalStatus: string | null;
	outcome: "pending" | "complete" | "partial" | "failed" | "malformed" | "unanswered" | "refused_budget" | "rejected";
	latencyMs: number | null;
	startedAt: string;
	finishedAt: string | null;
	share: { time_budget_ms?: number; budget?: { max_steps: number; max_fetches: number; max_tokens: number } | null; timeout_ms?: number } | null;
	reportedUsage: { steps: number; fetches: number; tokens: number; elapsed_ms: number } | null;
	chargedUsage: (Dimensions & { basis?: string; overrun?: boolean }) | null;
	errorCode: string | null;
	errorMessage: string | null;
	attemptLog: AttemptRecord[] | null;
};

export type Ledger = { total: Dimensions; charged: Dimensions; remaining: Dimensions; verifyChunks?: number };

export type RunDetail = RunSummary & { config: TrackerConfigView | null; attemptCounts: Record<string, number>; ledger: Ledger | null; workerCalls: WorkerCall[] };

export type WorkerHealth = { configured: boolean; url: string; state: "up" | "down" | "asleep" | "not_configured"; latencyMs: number | null; detail: string | null };

export type ClaimRow = { claimId: string; developmentId: string; rank: number | null; text: string; sourceUrl: string; label: ClaimLabel; evidence: string | null; verifyRequestId: string | null };

export type TrackerConfigView = {
	tracker: { name: string; topic: string; k: number; season: string };
	preferences: { roles: string[]; locations: string[]; remote_allowed: boolean; remote_region: string | null; skills: string[] };
	model: { provider: string; id: string };
	limits: Record<string, number>;
	allowedHosts: string[];
	companies: { id: string; name: string; careersUrl: string }[];
	orchestration: { totalBudget: { max_steps: number; max_fetches: number; max_tokens: number }; researcherSplit: number; timeBudgetMs: { researcher: number; verifier_per_chunk: number }; runDeadlineMs: number } | null;
};

export type TrackerOverview = {
	tracker: { id: string; name: string; config: TrackerConfigView | null; configHash: string | null; updatedAt: string };
	runInProgress: { id: string; startedAt: string; lastEventAt: string; phase: RunPhase | null; cancelRequested: boolean } | null;
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
	run: (id: string) => api<{ run: RunDetail }>(`/api/tracker/runs/${encodeURIComponent(id)}`),
	/** Starts a run in the background (202). The key makes a double click start one run, not two. */
	startRun: (idempotencyKey: string) => api<{ runId: string; status: RunStatus; baselineRunId: string | null }>("/api/tracker/runs", { method: "POST", body: { idempotencyKey } }),
	cancelRun: (id: string) => api<{ runId: string; cancelRequested: boolean; stoppedNow: boolean }>(`/api/tracker/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }),
	claims: (id: string, label?: ClaimLabel) => api<{ claims: ClaimRow[]; counts: ClaimCounts }>(`/api/tracker/runs/${encodeURIComponent(id)}/claims${label ? `?label=${label}` : ""}`),
	workers: () => api<{ researcher: WorkerHealth; verifier: WorkerHealth; checkedAt: string }>("/api/tracker/workers"),
	wakeVerifier: () => api<{ verifier: WorkerHealth; timeoutMs: number }>("/api/tracker/workers/verifier/wake", { method: "POST", body: {} }),
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

export const PHASES: { key: RunPhase; label: string }[] = [
	{ key: "starting", label: "Waking" },
	{ key: "researching", label: "Researching" },
	{ key: "verifying", label: "Verifying" },
	{ key: "reporting", label: "Writing report" },
	{ key: "done", label: "Done" },
];

export const CLAIM_LABEL_TEXT: Record<ClaimLabel, string> = {
	supported: "Supported",
	unsupported: "Unsupported",
	unreachable: "Unreachable",
	unverified: "Unverified",
};

export const WORKER_TEXT: Record<WorkerName, string> = { researcher: "Researcher", verifier: "Verifier" };

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}
