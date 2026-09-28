import type { DroppedItemJson, ReportItemJson, ReportJson, SourceRef } from "../../contracts/report";
import type { TrackerConfig } from "../config";
import type { Observation } from "./facts";
import { compareRanked, scoreFacts, type Scored } from "./rank";

export type Candidate = {
	observation: Observation;
	/** Every source document that supports this development (deduplicated sources merge here). */
	sources: SourceRef[];
	firstSeenAt: string | null;
	/** True when a source was fetched or confirmed during this run, not only carried from history. */
	reverified: boolean;
	/** Set when this run has explicit evidence the posting is gone (e.g. absent from the company feed). */
	excludedReason?: string;
	agentNote?: { reason: string; quote: string } | null;
};

export type Baseline = {
	runId: string;
	items: { identityKey: string; rank: number | null; company: string | null; title: string }[];
};

export type ReportInput = {
	runId: string;
	status: ReportJson["status"];
	stopReason: string | null;
	config: TrackerConfig;
	candidates: Candidate[];
	baseline: Baseline | null;
	everReported: Set<string>;
	comparisonReset: boolean;
	stats: ReportJson["stats"];
	notes: string[];
	now?: Date;
};

function listPhrase(values: string[]): string {
	if (values.length <= 1) return values[0] ?? "";
	return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/** Factual summary assembled only from extracted, quoted facts. */
function summarize(candidate: Candidate): string {
	const f = candidate.observation.facts;
	const parts = [`${f.company ?? "This company"} lists "${f.title}"`];
	if (f.locations.length) parts[0] += ` in ${listPhrase(f.locations.slice(0, 4))}`;
	parts[0] += ".";
	if (f.season) parts.push(`Season stated: ${f.season.replace("-", " ")}.`);
	if (f.skills.length) parts.push(`The posting mentions ${listPhrase(f.skills.slice(0, 6))}.`);
	if (f.compensation) parts.push(`Pay stated in the posting: "${f.compensation.slice(0, 160)}".`);
	return parts.join(" ");
}

/** Fit explanation: a judgment computed from the score, kept separate from facts. */
function explainFit(scored: Scored, config: TrackerConfig, facts: Observation["facts"]): string {
	const reasons: string[] = [];
	if (scored.breakdown.role > 0) reasons.push("role matches your target roles");
	if (scored.breakdown.season >= config.ranking.season_weight) reasons.push(`season matches ${config.tracker.season}`);
	if (scored.breakdown.location >= config.ranking.location_weight) reasons.push("location matches your preferences");
	else if (scored.breakdown.location > 0) reasons.push("remote-eligible");
	const matchedSkills = facts.skills.filter((skill) => config.preferences.skills.some((want) => want.toLowerCase() === skill.toLowerCase()));
	if (matchedSkills.length) reasons.push(`uses your configured skills (${matchedSkills.join(", ")})`);
	return reasons.length ? `Matches because the ${reasons.join("; ")}.` : "Weak match on your configured preferences.";
}

export function buildReport(input: ReportInput): ReportJson {
	const { config } = input;
	const now = input.now ?? new Date();
	const k = config.tracker.k;

	// One candidate per development; if duplicates slipped through, keep the reverified/richest one.
	const byIdentity = new Map<string, Candidate>();
	for (const candidate of input.candidates) {
		const key = candidate.observation.identity.key;
		const existing = byIdentity.get(key);
		if (!existing || (!existing.reverified && candidate.reverified)) {
			byIdentity.set(key, { ...candidate, sources: dedupeSources([...(existing?.sources ?? []), ...candidate.sources]) });
		} else {
			existing.sources = dedupeSources([...existing.sources, ...candidate.sources]);
		}
	}

	const scored = [...byIdentity.values()].map((candidate) => {
		const result = scoreFacts(candidate.observation.facts, config, { firstSeenAt: candidate.firstSeenAt, now });
		const excluded = candidate.excludedReason ?? result.excluded;
		return { candidate, result, excluded, identityKey: candidate.observation.identity.key, score: result.score, company: candidate.observation.facts.company, title: candidate.observation.facts.title };
	});

	const eligible = scored.filter((entry) => !entry.excluded && entry.score > 0).sort(compareRanked);
	const top = eligible.slice(0, k);
	const baselineRanks = new Map((input.baseline?.items ?? []).filter((item) => item.rank !== null).map((item) => [item.identityKey, item.rank!]));

	const items: ReportItemJson[] = top.map((entry, index) => {
		const { candidate, result } = entry;
		const facts = candidate.observation.facts;
		const section: ReportItemJson["section"] = baselineRanks.has(entry.identityKey)
			? "still"
			: input.everReported.has(entry.identityKey)
				? "returned"
				: "new";
		const notes = [...result.notes];
		if (!candidate.reverified) notes.push("Carried over from an earlier run; not re-fetched this run.");
		return {
			rank: index + 1,
			section,
			identityKey: entry.identityKey,
			company: facts.company,
			title: facts.title,
			locations: facts.locations,
			season: facts.season,
			score: entry.score,
			breakdown: result.breakdown,
			summary: summarize(candidate),
			fit: explainFit(result, config, facts),
			highlights: facts.highlights.slice(0, 3),
			agentNote: candidate.agentNote ?? null,
			unknowns: result.unknowns,
			notes,
			reverified: candidate.reverified,
			applicationUrl: facts.applicationUrl,
			postedAt: facts.postedAt,
			firstSeenAt: candidate.firstSeenAt,
			sources: candidate.sources.slice(0, 10),
			evidence: candidate.observation.evidence.slice(0, 60),
		};
	});

	const currentKeys = new Set(items.map((item) => item.identityKey));
	const scoredByKey = new Map(scored.map((entry) => [entry.identityKey, entry]));
	const eligibleRank = new Map(eligible.map((entry, index) => [entry.identityKey, index + 1]));
	const dropped: DroppedItemJson[] = (input.baseline?.items ?? [])
		.filter((item) => item.rank !== null && !currentKeys.has(item.identityKey))
		.map((item) => {
			const entry = scoredByKey.get(item.identityKey);
			let reason: string;
			if (!entry) reason = "Not observed this run (not re-verified); this does not mean the posting closed.";
			else if (entry.excluded) reason = `Excluded this run: ${entry.excluded}.`;
			else reason = `Outranked: now #${eligibleRank.get(item.identityKey) ?? "?"} with score ${entry.score}, below the top ${k}.`;
			return { identityKey: item.identityKey, company: item.company, title: item.title, previousRank: item.rank, reason };
		});

	const notes = [...input.notes];
	if (items.length < k) {
		notes.push(`Only ${items.length} posting${items.length === 1 ? "" : "s"} met the criteria with supporting evidence; Intersearch does not pad the list to ${k}.`);
	}

	return {
		schemaVersion: 1,
		runId: input.runId,
		status: input.status,
		stopReason: input.stopReason,
		generatedAt: now.toISOString(),
		topic: config.tracker.topic,
		k,
		season: config.tracker.season,
		comparison: {
			baselineRunId: input.baseline?.runId ?? null,
			reset: input.comparisonReset,
			note: input.comparisonReset
				? "The tracking target changed since the last complete run, so this run starts a new comparison."
				: input.baseline
					? null
					: "First run for this tracking target: everything is new.",
		},
		items,
		dropped,
		notes,
		stats: input.stats,
	};
}

function dedupeSources(sources: SourceRef[]): SourceRef[] {
	const seen = new Map<string, SourceRef>();
	for (const source of sources) if (!seen.has(source.sourceDocumentId)) seen.set(source.sourceDocumentId, source);
	return [...seen.values()];
}

const md = (text: string) => text.replace(/([\\`*_[\]<>|])/g, "\\$1");

/** Markdown export for reports/runN.md. Inert text: every web-derived string is escaped. */
export function renderMarkdown(report: ReportJson, meta: { trackerName: string; configHash: string }): string {
	const lines: string[] = [];
	const status = report.status === "complete" ? "Complete" : report.status === "partial" ? "PARTIAL" : "FAILED";
	lines.push(`# ${md(meta.trackerName)} report`);
	lines.push("");
	lines.push(`- **Run:** \`${report.runId}\``);
	lines.push(`- **Generated:** ${report.generatedAt}`);
	lines.push(`- **Status:** ${status}${report.stopReason ? ` (${md(report.stopReason)})` : ""}`);
	lines.push(`- **Topic:** ${md(report.topic)} (K = ${report.k}, season ${report.season})`);
	lines.push(`- **Compared with:** ${report.comparison.baselineRunId ? `\`${report.comparison.baselineRunId}\`` : "nothing (first run)"}`);
	lines.push(`- **Config hash:** \`${meta.configHash.slice(0, 12)}\``);
	const s = report.stats;
	lines.push(
		`- **Work:** ${s.modelCalls} model calls, ${s.inputTokens + s.outputTokens} tokens, ${s.searches} searches (${s.searchCredits} credits), ${s.networkRequests} network requests; articles: ${s.fetched} fetched, ${s.skipped} skipped as already seen, ${s.rejected} rejected, ${s.failed} failed; ${(s.elapsedMs / 1000).toFixed(1)} s`,
	);
	if (report.status !== "complete") {
		lines.push("");
		lines.push(`> This report is ${report.status}. It uses only the evidence gathered before the run stopped.`);
	}
	if (report.comparison.note) {
		lines.push("");
		lines.push(`> ${md(report.comparison.note)}`);
	}

	const section = (title: string, sectionItems: ReportItemJson[], empty: string) => {
		lines.push("");
		lines.push(`## ${title}`);
		lines.push("");
		if (sectionItems.length === 0) {
			lines.push(`_${empty}_`);
			return;
		}
		for (const item of sectionItems) {
			lines.push(`### #${item.rank} ${md(item.company ?? "")} — ${md(item.title)} (score ${item.score})`);
			lines.push("");
			lines.push(md(item.summary));
			lines.push("");
			lines.push(`- **Fit:** ${md(item.fit)}`);
			if (item.agentNote) lines.push(`- **Agent note:** ${md(item.agentNote.reason)} — quoted: "${md(item.agentNote.quote)}"`);
			for (const highlight of item.highlights) lines.push(`- **From the posting:** "${md(highlight)}"`);
			if (item.unknowns.length) lines.push(`- **Unknown:** ${item.unknowns.join(", ")}`);
			for (const note of item.notes) lines.push(`- _${md(note)}_`);
			lines.push(`- **Apply:** <${item.applicationUrl}>`);
			lines.push(`- **Sources:** ${item.sources.map((source) => `[${md(source.title ?? source.url)}](${source.url}) (fetched ${source.fetchedAt})`).join("; ")}`);
			lines.push("");
		}
	};

	const newItems = report.items.filter((item) => item.section === "new");
	const still = report.items.filter((item) => item.section !== "new");
	section("New since last run", newItems, "No new developments since the last run.");
	section("Still in top K", still, "Nothing carried over from the last run.");
	const returned = still.filter((item) => item.section === "returned");
	if (returned.length) {
		lines.push(`_Returned to the top K after dropping out earlier: ${returned.map((item) => `#${item.rank}`).join(", ")}._`);
	}

	lines.push("");
	lines.push("## Dropped");
	lines.push("");
	if (report.dropped.length === 0) lines.push("_Nothing dropped out of the top K._");
	for (const item of report.dropped) {
		lines.push(`- ${md(item.company ?? "")} — ${md(item.title)} (was #${item.previousRank ?? "?"}): ${md(item.reason)}`);
	}

	if (report.notes.length) {
		lines.push("");
		lines.push("## Notes");
		lines.push("");
		for (const note of report.notes) lines.push(`- ${md(note)}`);
	}
	lines.push("");
	return lines.join("\n");
}
