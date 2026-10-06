import type { SourceRef } from "../contracts/report";
import type { FinalizeBody, ObservationInput, TrackerStateDto } from "../contracts/tracker";
import type { Budget } from "./budget";
import type { TrackerConfig } from "./config";
import type { Facts, Observation } from "./domain/facts";
import { locationKey, normalizeTitle } from "./domain/normalize";
import { buildReport, renderMarkdown, type Candidate } from "./domain/report";
import type { RunStore } from "./store";
import type { RunMemory } from "./tools/context";
import type { AcceptedNote } from "./tools/finish";

type Group = { observations: Observation[]; sources: SourceRef[]; fetchedThisRun: boolean };

function feedStatus(memory: RunMemory, facts: Facts, providerJobId: string | null) {
	if (!facts.companyId || !providerJobId) return "unknown" as const;
	const feed = memory.feeds.get(facts.companyId);
	if (!feed) return "unknown" as const;
	return feed.jobIds.has(providerJobId) ? ("listed" as const) : ("absent" as const);
}

/**
 * Several sources can describe one development (the job-board record and the careers page).
 * The structured job-board record is the base; missing facts are filled from the other sources,
 * and every source's quotes are kept, each still pointing at the document it came from.
 */
export function mergeObservations(observations: Observation[]): Observation {
	const ordered = [...observations].sort(
		(a, b) => Number(Boolean(b.facts.postedAt)) - Number(Boolean(a.facts.postedAt)) || Number(b.identity.method === "provider_id") - Number(a.identity.method === "provider_id") || b.evidence.length - a.evidence.length,
	);
	const base = ordered[0]!;
	const facts: Facts = { ...base.facts, locations: [...base.facts.locations], skills: [...base.facts.skills], eligibility: [...base.facts.eligibility], highlights: [...base.facts.highlights] };
	const evidence = [...base.evidence];
	const seen = new Set(evidence.map((item) => `${item.field}|${item.quote}`));
	for (const other of ordered.slice(1)) {
		const o = other.facts;
		const fill = <K extends keyof Facts>(key: K, empty: (value: Facts[K]) => boolean, fields: string[]) => {
			if (empty(facts[key]) && !empty(o[key])) {
				facts[key] = o[key];
				for (const item of other.evidence) if (fields.some((field) => item.field === field || item.field.startsWith(field)) && !seen.has(`${item.field}|${item.quote}`)) {
					evidence.push(item);
					seen.add(`${item.field}|${item.quote}`);
				}
			}
		};
		fill("locations", (value) => (value as string[]).length === 0, ["location"]);
		fill("season", (value) => !value || !String(value).includes("-"), ["season"]);
		fill("compensation", (value) => !value, ["compensation"]);
		fill("eligibility", (value) => (value as string[]).length === 0, ["eligibility"]);
		fill("highlights", (value) => (value as string[]).length === 0, ["highlight"]);
		facts.remote ||= o.remote;
		for (const skill of o.skills) {
			if (!facts.skills.includes(skill)) {
				facts.skills.push(skill);
				const quote = other.evidence.find((item) => item.field === `skill:${skill}`);
				if (quote && !seen.has(`${quote.field}|${quote.quote}`)) {
					evidence.push(quote);
					seen.add(`${quote.field}|${quote.quote}`);
				}
			}
		}
	}
	return { ...base, facts, evidence };
}

/**
 * Turns what the run learned into ranking candidates:
 * - every posting observed this run (fetched, or reused from cache), merged by development identity;
 * - every previously known development not observed this run, carried forward with its last facts,
 *   and excluded only when this run's company feed shows the job id is gone.
 */
export function assembleCandidates(input: { memory: RunMemory; state: TrackerStateDto | null; store: RunStore | null; notes: AcceptedNote[]; now: Date }) {
	const { memory, state, store, notes, now } = input;
	const known = new Map((state?.opportunities ?? []).map((opportunity) => [opportunity.identityKey, opportunity]));
	const noteByIdentity = new Map(notes.map((note) => [note.identityKey, note]));

	const groups = new Map<string, Group>();
	for (const [docId, observation] of memory.observations) {
		const key = observation.identity.key;
		const group = groups.get(key) ?? { observations: [], sources: [], fetchedThisRun: false };
		group.observations.push(observation);
		group.sources.push({ sourceDocumentId: store?.resolveId(docId) ?? docId, url: observation.source.url, title: observation.source.title, fetchedAt: observation.source.fetchedAt });
		group.fetchedThisRun ||= Boolean(store?.getById(docId)?.fetchedThisRun);
		groups.set(key, group);
	}

	const candidates: Candidate[] = [];
	const observationInputs: ObservationInput[] = [];

	for (const [key, group] of groups) {
		const resolvedGroup = group.observations.map((observation) => ({
			...observation,
			evidence: observation.evidence.map((evidence) => ({ ...evidence, sourceDocumentId: store?.resolveId(evidence.sourceDocumentId) ?? evidence.sourceDocumentId })),
		}));
		const resolved = mergeObservations(resolvedGroup);
		const primary = resolved;
		const listed = feedStatus(memory, primary.facts, primary.identity.providerJobId) === "listed";
		const note = noteByIdentity.get(key);
		candidates.push({
			observation: resolved,
			sources: group.sources,
			firstSeenAt: known.get(key)?.firstSeenAt ?? now.toISOString(),
			reverified: group.fetchedThisRun || listed,
			agentNote: note ? { quote: note.quote } : null,
		});
		observationInputs.push({
			identityKey: key,
			identityMethod: primary.identity.method,
			providerJobId: primary.identity.providerJobId,
			companyId: primary.facts.companyId,
			companyName: primary.facts.company ?? "Unknown company",
			title: primary.facts.title.slice(0, 300),
			normalizedTitle: normalizeTitle(primary.facts.title).slice(0, 300),
			locationKey: locationKey(primary.facts.locations.join("; ")),
			season: primary.facts.season,
			applicationUrl: primary.facts.applicationUrl,
			facts: primary.facts as unknown as Record<string, unknown>,
			evidence: resolved.evidence,
			sourceDocumentIds: [...new Set(group.sources.map((source) => source.sourceDocumentId))].slice(0, 10),
			reverified: group.fetchedThisRun || listed,
		});
	}

	for (const opportunity of state?.opportunities ?? []) {
		if (groups.has(opportunity.identityKey) || !opportunity.lastObservation || opportunity.lastObservation.sources.length === 0) continue;
		const facts = opportunity.lastObservation.facts as unknown as Facts;
		const status = feedStatus(memory, facts, opportunity.providerJobId);
		const feedDate = facts.companyId ? memory.feeds.get(facts.companyId)?.fetchedAt.slice(0, 10) : null;
		candidates.push({
			observation: {
				identity: { key: opportunity.identityKey, method: opportunity.providerJobId ? "provider_id" : "title_location_season", providerJobId: opportunity.providerJobId },
				facts,
				evidence: opportunity.lastObservation.evidence,
				source: { ...opportunity.lastObservation.sources[0]!, title: opportunity.lastObservation.sources[0]!.title },
			},
			sources: opportunity.lastObservation.sources,
			firstSeenAt: opportunity.firstSeenAt,
			reverified: status === "listed",
			excludedReason: status === "absent" ? `no longer listed on ${facts.company ?? "the company"}'s job board as of ${feedDate}` : undefined,
		});
	}

	return { candidates, observationInputs };
}

export function buildFinalizeBody(input: {
	runId: string;
	config: TrackerConfig;
	configHash: string;
	outcome: { status: FinalizeBody["status"]; stopReason: string | null; errorCode: string | null };
	memory: RunMemory;
	state: TrackerStateDto | null;
	store: RunStore | null;
	notes: AcceptedNote[];
	budget: Budget;
	extraNotes: string[];
}): FinalizeBody {
	const now = new Date();
	const { candidates, observationInputs } = assembleCandidates({ memory: input.memory, state: input.state, store: input.store, notes: input.notes, now });
	const totals = input.budget.snapshot;
	const count = (status: string) => input.memory.attempts.filter((attempt) => attempt.status === status).length;

	const report = buildReport({
		runId: input.runId,
		status: input.outcome.status,
		stopReason: input.outcome.stopReason,
		config: input.config,
		candidates,
		baseline: input.state?.baseline ?? null,
		everReported: new Set((input.state?.opportunities ?? []).filter((opportunity) => opportunity.firstReportedAt).map((opportunity) => opportunity.identityKey)),
		comparisonReset: input.state?.comparisonReset ?? false,
		stats: {
			fetched: count("fetched"),
			skipped: count("skipped_seen"),
			rejected: count("rejected"),
			failed: count("failed"),
			searches: totals.searches,
			modelCalls: totals.modelCalls,
			inputTokens: totals.inputTokens,
			outputTokens: totals.outputTokens,
			searchCredits: totals.searchCredits,
			networkRequests: totals.networkRequests,
			elapsedMs: totals.elapsedMs,
		},
		notes: input.extraNotes,
		now,
	});
	const markdown = renderMarkdown(report, { trackerName: input.config.tracker.name, configHash: input.configHash });

	return {
		status: input.outcome.status,
		stopReason: input.outcome.stopReason,
		errorCode: input.outcome.errorCode,
		budgetTotals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value)])),
		report,
		markdown,
		observations: observationInputs,
	};
}
