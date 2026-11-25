import { prisma } from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";
import { reportJsonSchema, type ReportJsonV2 } from "../contracts/report";
import { baselineFrom, type Baseline } from "./report";
import type { AttemptRecord } from "./worker-client";

/**
 * Everything the orchestrator reads or writes in the database. Workers never reach this code
 * (they have no database access at all); the API's tracker service reads the same tables.
 */

const json = (value: unknown) => value as Prisma.InputJsonValue;

export type CallOutcome = "pending" | "complete" | "partial" | "failed" | "malformed" | "unanswered" | "refused_budget" | "rejected";

/**
 * The run a new run is compared against (and falls back to when the researcher fails): the latest
 * earlier run for the same tracking target whose top K came fresh from research. That is a
 * complete run, or an orchestrated partial run that was not stale (its researcher answered; a
 * verifier failure leaves claims unverified but does not change the ranking). 1B partial runs
 * keep their old meaning and are not used.
 */
const freshRunWhere = (trackerId: string, comparisonKey: string, excludeRunId: string): Prisma.RunWhereInput => ({
	trackerId,
	comparisonKey,
	id: { not: excludeRunId },
	report: { isNot: null },
	OR: [{ status: "complete" }, { kind: "orchestrated", status: "partial", stale: false }],
});

export async function loadRunContext(runId: string) {
	const run = await prisma.run.findUniqueOrThrow({ where: { id: runId }, include: { tracker: true } });
	const previous = await prisma.run.findFirst({
		where: freshRunWhere(run.trackerId, run.comparisonKey, run.id),
		orderBy: { startedAt: "desc" },
		include: { report: true },
	});
	let baseline: Baseline | null = null;
	if (previous?.report) {
		const parsed = reportJsonSchema.safeParse(previous.report.reportJson);
		if (parsed.success) baseline = baselineFrom(previous.id, parsed.data);
	}
	const reported = await prisma.opportunity.findMany({ where: { trackerId: run.trackerId, firstReportedAt: { not: null } }, select: { identityKey: true } });
	return { run, baseline, everReported: new Set(reported.map((row) => row.identityKey)) };
}

export async function markStarted(runId: string, baselineRunId: string | null) {
	await prisma.run.update({ where: { id: runId }, data: { kind: "orchestrated", phase: "starting", baselineRunId, lastEventAt: new Date() } });
}

export async function setPhase(runId: string, phase: "starting" | "researching" | "verifying" | "reporting" | "done", ledger?: unknown) {
	await prisma.run.update({ where: { id: runId }, data: { phase, lastEventAt: new Date(), ...(ledger ? { ledger: json(ledger) } : {}) } });
}

/** Keeps the run from looking abandoned during a long call; returns whether a cancel was requested. */
export async function heartbeat(runId: string): Promise<boolean> {
	const run = await prisma.run.update({ where: { id: runId }, data: { lastEventAt: new Date() }, select: { cancelRequested: true } });
	return run.cancelRequested;
}

/** Written before the request is sent, so the request_id is on record even if this process dies. */
export async function createCall(input: { runId: string; requestId: string; service: string; endpoint: string; share: unknown; outcome?: CallOutcome; errorCode?: string; errorMessage?: string }) {
	await prisma.workerCall.create({
		data: {
			runId: input.runId,
			requestId: input.requestId,
			service: input.service,
			endpoint: input.endpoint,
			share: json(input.share),
			outcome: input.outcome ?? "pending",
			errorCode: input.errorCode ?? null,
			errorMessage: input.errorMessage ?? null,
			...(input.outcome && input.outcome !== "pending" ? { finishedAt: new Date() } : {}),
		},
	});
}

export async function recordAttempts(requestId: string, attempts: AttemptRecord[]) {
	await prisma.workerCall.update({ where: { requestId }, data: { attempts: attempts.length, attemptLog: json(attempts), finalStatus: String(attempts.at(-1)?.status ?? "") || null } });
}

export async function finishCall(
	runId: string,
	requestId: string,
	data: { outcome: CallOutcome; attempts: AttemptRecord[]; latencyMs: number | null; reportedUsage: unknown; chargedUsage: unknown; errorCode: string | null; errorMessage: string | null },
) {
	await prisma.workerCall.update({
		where: { requestId },
		data: {
			outcome: data.outcome,
			attempts: data.attempts.length,
			attemptLog: json(data.attempts),
			finalStatus: data.attempts.length ? String(data.attempts.at(-1)!.status) : null,
			latencyMs: data.latencyMs,
			finishedAt: new Date(),
			reportedUsage: data.reportedUsage === null ? Prisma.DbNull : json(data.reportedUsage),
			chargedUsage: data.chargedUsage === null ? Prisma.DbNull : json(data.chargedUsage),
			errorCode: data.errorCode?.slice(0, 80) ?? null,
			errorMessage: data.errorMessage?.slice(0, 500) ?? null,
		},
	});
	await prisma.run.update({ where: { id: runId }, data: { lastEventAt: new Date() } });
}

const normalizeTitle = (title: string) => title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);

/** "Company — Title" (the researcher's development title) → its parts. */
function splitTitle(title: string): { company: string; title: string } {
	const index = title.indexOf(" — ");
	if (index > 0) return { company: title.slice(0, index).slice(0, 120), title: title.slice(index + 3).slice(0, 300) || title.slice(0, 300) };
	return { company: "Unknown company", title: title.slice(0, 300) };
}

function providerOf(id: string): { provider: string | null; providerJobId: string | null } {
	const match = /^greenhouse:[^:]+:(\d+)$/.exec(id);
	return match ? { provider: "greenhouse", providerJobId: match[1]! } : { provider: null, providerJobId: null };
}

export type SaveReportInput = {
	runId: string;
	trackerId: string;
	report: ReportJsonV2;
	markdown: string;
	baselineRunId: string | null;
	/** request_id of the verify request that labelled each claim. */
	verifyRequestByClaim: Map<string, string>;
	errorCode: string | null;
	ledger: unknown;
	budgetTotals: Record<string, number>;
};

/** One transaction: report, items, claims, opportunities, and the run's final state. */
export async function saveReport(input: SaveReportInput) {
	const { report } = input;
	const now = new Date();
	const fresh = !report.stale && report.status !== "failed";
	await prisma.$transaction(
		async (tx) => {
			const opportunityIdByKey = new Map<string, string>();
			if (!report.stale) {
				for (const item of report.items) {
					const parts = splitTitle(item.title);
					const data = { companyName: parts.company, title: parts.title, normalizedTitle: normalizeTitle(parts.title), ...providerOf(item.developmentId) };
					const opportunity = await tx.opportunity.upsert({
						where: { trackerId_identityKey: { trackerId: input.trackerId, identityKey: item.developmentId } },
						create: { trackerId: input.trackerId, identityKey: item.developmentId, ...data, firstSeenAt: now, lastSeenAt: now },
						update: { ...data, lastSeenAt: now },
					});
					opportunityIdByKey.set(item.developmentId, opportunity.id);
				}
				const droppedKeys = report.dropped.map((item) => item.developmentId);
				if (droppedKeys.length) {
					const found = await tx.opportunity.findMany({ where: { trackerId: input.trackerId, identityKey: { in: droppedKeys } }, select: { id: true, identityKey: true } });
					for (const row of found) opportunityIdByKey.set(row.identityKey, row.id);
				}
			}

			const created = await tx.report.create({
				data: { runId: input.runId, schemaVersion: 2, status: report.status, reportJson: json(report), markdown: input.markdown, previousCompleteRunId: input.baselineRunId },
			});

			// Stale items belong to an earlier run's report; this run stores them only in its JSON.
			if (!report.stale) {
				for (const item of report.items) {
					const reportItem = await tx.reportItem.create({
						data: {
							reportId: created.id,
							opportunityId: opportunityIdByKey.get(item.developmentId)!,
							rank: item.rank,
							section: item.section,
							score: 0,
							scoreBreakdown: json({}),
							summary: item.summary,
							evidenceReferences: json([]),
						},
					});
					if (item.claims.length) {
						await tx.claim.createMany({
							data: item.claims.map((claim) => ({
								runId: input.runId,
								reportItemId: reportItem.id,
								developmentId: item.developmentId,
								claimId: claim.claimId,
								text: claim.text,
								sourceUrl: claim.sourceUrl,
								label: claim.label,
								evidence: claim.evidence,
								verifyRequestId: input.verifyRequestByClaim.get(claim.claimId) ?? null,
							})),
						});
					}
				}
				const droppedRows = report.dropped
					.filter((item) => opportunityIdByKey.has(item.developmentId))
					.map((item) => ({ reportId: created.id, opportunityId: opportunityIdByKey.get(item.developmentId)!, rank: null, section: "dropped" as const, score: 0, scoreBreakdown: json({}), summary: item.reason, evidenceReferences: json([]) }));
				if (droppedRows.length) await tx.reportItem.createMany({ data: droppedRows, skipDuplicates: true });
			}

			if (fresh && report.items.length) {
				await tx.opportunity.updateMany({ where: { trackerId: input.trackerId, identityKey: { in: report.items.map((item) => item.developmentId) }, firstReportedAt: null }, data: { firstReportedAt: now } });
			}

			await tx.run.update({
				where: { id: input.runId },
				data: {
					status: report.status,
					partial: report.status !== "complete",
					finishedAt: now,
					lastEventAt: now,
					stopReason: report.stopReason,
					errorCode: input.errorCode,
					phase: "done",
					failedWorkers: report.failedWorkers,
					stale: report.stale,
					ledger: json(input.ledger),
					budgetTotals: json(input.budgetTotals),
					baselineRunId: input.baselineRunId,
				},
			});
		},
		{ timeout: 30_000 },
	);
}

/** Last resort when even the report could not be saved: the run must not stay "running". */
export async function markFailed(runId: string, message: string) {
	await prisma.run.updateMany({
		where: { id: runId, status: "running" },
		data: { status: "failed", partial: true, finishedAt: new Date(), lastEventAt: new Date(), stopReason: message.slice(0, 400), errorCode: "orchestrator_error", phase: "done" },
	});
}
