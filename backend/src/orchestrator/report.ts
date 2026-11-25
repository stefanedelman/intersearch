import type { ClaimLabelValue, DroppedItemV2, ReportClaim, ReportItemV2, ReportJson, ReportJsonV2 } from "../contracts/report";
import type { Development } from "../shared/contract";

/**
 * The v2 report: pure functions, no database or network. Ranking is the researcher's (its
 * developments arrive best first); the orchestrator adds claim labels, the comparison against the
 * previous run's top K, and the failure semantics (stale, unverified).
 */

export type BaselineItem = { developmentId: string; rank: number; title: string; summary: string; claims: ReportClaim[] };
export type Baseline = { runId: string; items: BaselineItem[] };

/** A previous run's top K, from its stored report (1B v1 reports have no claims). */
export function baselineFrom(runId: string, report: ReportJson): Baseline {
	if (report.schemaVersion === 1) {
		return {
			runId,
			items: report.items.map((item) => ({
				developmentId: item.identityKey,
				rank: item.rank,
				title: item.company ? `${item.company} — ${item.title}` : item.title,
				summary: item.summary,
				claims: [],
			})),
		};
	}
	return {
		runId,
		items: report.items.map((item) => ({ developmentId: item.developmentId, rank: item.rank, title: item.title, summary: item.summary, claims: item.claims })),
	};
}

export type Verdicts = Map<string, { label: Exclude<ClaimLabelValue, "unverified">; evidence: string | null }>;

export type WorkerState = ReportJsonV2["workers"]["researcher"];

export type ReportInput = {
	runId: string;
	status: ReportJsonV2["status"];
	stopReason: string | null;
	topic: string;
	k: number;
	/** Null when the researcher gave no usable answer: the report shows the baseline, marked stale. */
	developments: Development[] | null;
	/** Why there are no fresh results, when developments is null. Default: the researcher was unavailable. */
	staleBecause?: string;
	verdicts: Verdicts;
	baseline: Baseline | null;
	/** development ids reported by any earlier fresh run (for "returned"). */
	everReported: Set<string>;
	workers: ReportJsonV2["workers"];
	failedWorkers: ReportJsonV2["failedWorkers"];
	notes: string[];
	stats: Omit<ReportJsonV2["stats"], "claims">;
	now: Date;
};

export function labelClaims(development: Development, verdicts: Verdicts): ReportClaim[] {
	return development.claims.map((claim) => {
		const verdict = verdicts.get(claim.claim_id);
		return {
			claimId: claim.claim_id,
			text: claim.text,
			sourceUrl: claim.source_url,
			label: verdict?.label ?? "unverified",
			evidence: verdict?.label === "supported" ? verdict.evidence : null,
		};
	});
}

export function buildReport(input: ReportInput): ReportJsonV2 {
	const stale = input.developments === null;
	const baselineRanks = new Map((input.baseline?.items ?? []).map((item) => [item.developmentId, item.rank]));
	let items: ReportItemV2[];
	let dropped: DroppedItemV2[] = [];
	const notes = [...input.notes];

	if (stale) {
		items = (input.baseline?.items ?? []).slice(0, input.k).map((item, index) => ({
			rank: index + 1,
			section: "still",
			developmentId: item.developmentId,
			title: item.title,
			summary: item.summary,
			claims: item.claims,
			stale: true,
			fromRunId: input.baseline!.runId,
		}));
		const because = input.staleBecause ?? "researcher unavailable";
		notes.unshift(
			input.baseline
				? `No new results this run (${because}). Showing the top ${items.length} from run ${input.baseline.runId}, marked stale; their claims were not re-checked.`
				: `No new results this run (${because}), and there is no earlier run to fall back on.`,
		);
	} else {
		items = input.developments!.slice(0, input.k).map((development, index) => ({
			rank: index + 1,
			section: baselineRanks.has(development.id) ? "still" : input.everReported.has(development.id) ? "returned" : "new",
			developmentId: development.id,
			title: development.title,
			summary: development.summary,
			claims: labelClaims(development, input.verdicts),
			stale: false,
			fromRunId: null,
		}));
		const current = new Set(items.map((item) => item.developmentId));
		dropped = (input.baseline?.items ?? [])
			.filter((item) => !current.has(item.developmentId))
			.map((item) => ({ developmentId: item.developmentId, title: item.title, previousRank: item.rank, reason: "Not in the researcher's top K this run." }));
		if (items.length < input.k) notes.push(`The researcher returned ${items.length} of K = ${input.k}; Intersearch does not pad the list.`);
	}

	// Counts cover only claims checked in this run (stale items' claims belong to their own run).
	const claims = { supported: 0, unsupported: 0, unreachable: 0, unverified: 0 };
	if (!stale) for (const item of items) for (const claim of item.claims) claims[claim.label] += 1;

	return {
		schemaVersion: 2,
		runId: input.runId,
		status: input.status,
		stopReason: input.stopReason ? input.stopReason.slice(0, 400) : null,
		generatedAt: input.now.toISOString(),
		topic: input.topic,
		k: input.k,
		stale,
		failedWorkers: input.failedWorkers,
		workers: input.workers,
		comparison: {
			baselineRunId: input.baseline?.runId ?? null,
			note: input.baseline ? null : "First run for this tracking target: everything is new.",
		},
		items,
		dropped: dropped.slice(0, 20),
		notes: notes.map((note) => note.slice(0, 400)).slice(0, 20),
		stats: { ...input.stats, claims },
	};
}

const md = (text: string) => text.replace(/([\\`*_[\]<>|#])/g, "\\$1").replace(/\r?\n/g, " ");

const LABEL_TEXT: Record<ClaimLabelValue, string> = {
	supported: "SUPPORTED",
	unsupported: "UNSUPPORTED",
	unreachable: "UNREACHABLE",
	unverified: "UNVERIFIED",
};

/** Markdown export (runs/<id>/report.md, reports/a2-runN.md). Every worker-written string is escaped. */
export function renderMarkdown(report: ReportJsonV2, meta: { trackerName: string; configHash: string }): string {
	const lines: string[] = [];
	const status = report.status === "complete" ? "Complete" : report.status === "partial" ? "PARTIAL" : "FAILED";
	lines.push(`# ${md(meta.trackerName)} report`, "");
	lines.push(`- **Run:** \`${report.runId}\``);
	lines.push(`- **Generated:** ${report.generatedAt}`);
	lines.push(`- **Status:** ${status}${report.stopReason ? ` (${md(report.stopReason)})` : ""}`);
	lines.push(`- **Topic:** ${md(report.topic)} (K = ${report.k})`);
	lines.push(`- **Workers:** researcher ${report.workers.researcher}, verifier ${report.workers.verifier}${report.failedWorkers.length ? ` (failed: ${report.failedWorkers.join(", ")})` : ""}`);
	lines.push(`- **Compared with:** ${report.comparison.baselineRunId ? `\`${report.comparison.baselineRunId}\`` : "nothing (first run)"}`);
	lines.push(`- **Config hash:** \`${meta.configHash.slice(0, 12)}\``);
	const s = report.stats;
	lines.push(
		`- **Claims:** ${s.claims.supported} supported, ${s.claims.unsupported} unsupported, ${s.claims.unreachable} unreachable, ${s.claims.unverified} unverified`,
		`- **Budget charged:** ${s.budget.charged.steps}/${s.budget.total.steps} steps, ${s.budget.charged.fetches}/${s.budget.total.fetches} fetches, ${s.budget.charged.tokens}/${s.budget.total.tokens} tokens; ${s.workerCalls} worker requests; ${(s.elapsedMs / 1000).toFixed(1)} s`,
	);
	if (report.stale) lines.push("", "> **Stale:** the researcher did not answer, so these are the previous run's results. Nothing below was re-checked.");
	else if (report.status !== "complete") {
		const why = [
			report.workers.researcher === "partial" ? "the researcher stopped early, so it lists only what was found before then" : null,
			s.claims.unverified ? `${s.claims.unverified} claims marked UNVERIFIED were not checked by the verifier` : null,
		].filter(Boolean);
		lines.push("", `> This report is ${report.status}${why.length ? `: ${why.join("; ")}` : ""}.`);
	}
	if (report.comparison.note) lines.push("", `> ${md(report.comparison.note)}`);

	const section = (title: string, sectionItems: ReportItemV2[], empty: string) => {
		lines.push("", `## ${title}`, "");
		if (sectionItems.length === 0) {
			lines.push(`_${empty}_`);
			return;
		}
		for (const item of sectionItems) {
			lines.push(`### #${item.rank} ${md(item.title)}${item.stale ? " (stale)" : ""}`, "");
			if (item.summary) lines.push(md(item.summary), "");
			if (item.claims.length === 0) lines.push("- _No claims (an earlier run's result)._");
			for (const claim of item.claims) {
				lines.push(`- **${LABEL_TEXT[claim.label]}:** ${md(claim.text)} — <${claim.sourceUrl}>`);
				if (claim.evidence) lines.push(`  > ${md(claim.evidence)}`);
			}
			lines.push("");
		}
	};
	if (report.stale) {
		section("Previous top K (stale)", report.items, "Nothing to show.");
	} else {
		section("New since last run", report.items.filter((item) => item.section === "new"), "No new developments since the last run.");
		section("Still in top K", report.items.filter((item) => item.section !== "new"), "Nothing carried over from the last run.");
		const returned = report.items.filter((item) => item.section === "returned");
		if (returned.length) lines.push(`_Returned to the top K after dropping out earlier: ${returned.map((item) => `#${item.rank}`).join(", ")}._`);
		lines.push("", "## Dropped", "");
		if (report.dropped.length === 0) lines.push("_Nothing dropped out of the top K._");
		for (const item of report.dropped) lines.push(`- ${md(item.title)} (was #${item.previousRank ?? "?"}): ${md(item.reason)}`);
	}
	if (report.notes.length) {
		lines.push("", "## Notes", "");
		for (const note of report.notes) lines.push(`- ${md(note)}`);
	}
	lines.push("");
	return lines.join("\n");
}
