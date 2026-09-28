import type { TrackerConfig } from "../config";
import type { Budget } from "../budget";
import type { Observation } from "../domain/facts";
import type { guardedGet, TransportLimits } from "../fetch/transport";
import type { UrlPolicy } from "../fetch/url-policy";
import type { Search } from "../providers/tavily";
import type { RunStore } from "../store";
import type { Trace } from "../trace";

/** What the agent has learned during this run. */
export type RunMemory = {
	/** Observations keyed by source document id. */
	observations: Map<string, Observation>;
	/** Job ids present in each company's feed this run (for "no longer listed" detection). */
	feeds: Map<string, { jobIds: Set<string>; fetchedAt: string }>;
	/** Identity keys reported in earlier complete runs. */
	everReported: Set<string>;
	/** Sources fetched or reused this run, for the per-run articles table. */
	attempts: { status: string; url: string }[];
};

export type ToolContext = {
	config: TrackerConfig;
	policy: UrlPolicy;
	transport: TransportLimits;
	budget: Budget;
	trace: Trace;
	step: number;
	parentEventId: string | null;
	/** Null in standalone CLI mode: no cache, nothing persisted. */
	store: RunStore | null;
	search: Search | null;
	memory: RunMemory;
	/** Injectable for tests; defaults to the guarded network transport. */
	fetcher?: typeof guardedGet;
};

export function policyFor(config: TrackerConfig): UrlPolicy {
	return {
		allowedSchemes: config.fetch_policy.allowed_schemes,
		allowedPorts: config.fetch_policy.allowed_ports,
		allowedHosts: config.fetch_policy.allowed_hosts,
	};
}

export function transportFor(config: TrackerConfig): TransportLimits {
	return {
		timeoutMs: config.limits.request_timeout_seconds * 1000,
		maxBytes: config.limits.max_response_bytes,
		maxRedirects: config.limits.max_redirects,
	};
}

export function emptyMemory(): RunMemory {
	return { observations: new Map(), feeds: new Map(), everReported: new Set(), attempts: [] };
}
