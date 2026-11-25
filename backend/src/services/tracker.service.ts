import { prisma } from "../lib/prisma";
import { errors } from "../lib/errors";
import { serverEnv } from "../lib/env";
import { Prisma } from "../generated/prisma/client";
import type { Run, Tracker, WorkerCall } from "../generated/prisma/client";
import { AppError } from "../lib/errors";
import { ConfigError, comparisonKey, configHash, loadConfig, ORCHESTRATION_DEFAULTS, trackerConfigSchema, type TrackerConfig } from "../shared/config";
import type { JobRunner } from "../orchestrator/jobs";
import { claimLabels, type ClaimLabelValue } from "../contracts/report";
import type { StartRunResponse } from "../contracts/tracker";
import type { ReportJson } from "../contracts/report";

const STALE_RUN_MS = 10 * 60 * 1000;
const json = (value: unknown) => value as Prisma.InputJsonValue;

async function trackerFor(profileId: string): Promise<Tracker> {
	const tracker = await prisma.tracker.upsert({ where: { profileId }, create: { profileId }, update: {} });
	return tracker;
}

/** Every run lookup is scoped through the caller's tracker; other users' runs are 404. */
async function ownedRun(profileId: string, runId: string): Promise<Run> {
	const tracker = await trackerFor(profileId);
	const run = await prisma.run.findFirst({ where: { id: runId, trackerId: tracker.id } });
	if (!run) throw errors.notFound("Run not found.");
	return run;
}

function publicConfig(config: TrackerConfig | null) {
	if (!config) return null;
	return {
		tracker: config.tracker,
		preferences: config.preferences,
		model: { provider: config.model.provider, id: config.model.id },
		limits: config.limits,
		allowedHosts: config.fetch_policy.allowed_hosts,
		companies: config.companies.map((company) => ({ id: company.id, name: company.name, careersUrl: company.careers_url })),
		orchestration: config.orchestration
			? {
					totalBudget: config.orchestration.total_budget,
					researcherSplit: config.orchestration.split.researcher,
					timeBudgetMs: config.orchestration.time_budget_ms,
					runDeadlineMs: config.orchestration.run_deadline_ms,
				}
			: null,
	};
}

type ClaimCounts = Record<ClaimLabelValue, number>;

/** Claim label counts per run, for run lists and details (empty counts for 1B runs). */
async function claimCountsFor(runIds: string[]): Promise<Map<string, ClaimCounts>> {
	const byRun = new Map<string, ClaimCounts>();
	if (!runIds.length) return byRun;
	const rows = await prisma.claim.groupBy({ by: ["runId", "label"], where: { runId: { in: runIds } }, _count: { _all: true } });
	for (const row of rows) {
		const counts = byRun.get(row.runId) ?? { supported: 0, unsupported: 0, unreachable: 0, unverified: 0 };
		counts[row.label] = row._count._all;
		byRun.set(row.runId, counts);
	}
	return byRun;
}

function runSummary(run: Run & { report?: { items: { section: string }[] } | null; _count?: { fetchAttempts: number } }, claimCounts?: ClaimCounts) {
	const counts = { new: 0, still: 0, returned: 0, dropped: 0 };
	for (const item of run.report?.items ?? []) counts[item.section as keyof typeof counts] += 1;
	return {
		id: run.id,
		status: run.status,
		startedAt: run.startedAt.toISOString(),
		finishedAt: run.finishedAt?.toISOString() ?? null,
		lastEventAt: run.lastEventAt.toISOString(),
		stopReason: run.stopReason,
		errorCode: run.errorCode,
		partial: run.partial,
		baselineRunId: run.baselineRunId,
		hasReport: Boolean(run.report),
		counts,
		budgetTotals: run.budgetTotals,
		configHash: run.configHash,
		kind: run.kind,
		phase: run.phase,
		failedWorkers: run.failedWorkers ?? [],
		stale: run.stale,
		cancelRequested: run.cancelRequested,
		claimCounts: claimCounts ?? null,
	};
}

/** A worker call as the dashboard shows it. Never includes bodies, tokens, or keys. */
function workerCallDto(call: WorkerCall) {
	return {
		requestId: call.requestId,
		service: call.service,
		endpoint: call.endpoint,
		attempts: call.attempts,
		finalStatus: call.finalStatus,
		outcome: call.outcome,
		latencyMs: call.latencyMs,
		startedAt: call.startedAt.toISOString(),
		finishedAt: call.finishedAt?.toISOString() ?? null,
		share: call.share,
		reportedUsage: call.reportedUsage,
		chargedUsage: call.chargedUsage,
		errorCode: call.errorCode,
		errorMessage: call.errorMessage,
		attemptLog: call.attemptLog,
	};
}

async function finalizeStale(trackerId: string, now: Date) {
	const stale = await prisma.run.findMany({
		where: { trackerId, status: "running", lastEventAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } },
		select: { id: true },
	});
	if (stale.length === 0) return [];
	await prisma.run.updateMany({
		where: { id: { in: stale.map((run) => run.id) }, status: "running" },
		data: { status: "partial", partial: true, finishedAt: now, stopReason: "abandoned: no activity for 10 minutes", errorCode: "abandoned" },
	});
	return stale.map((run) => run.id);
}

export const trackerService = {
	async getTracker(profileId: string) {
		const tracker = await trackerFor(profileId);
		const [running, latest] = await Promise.all([
			prisma.run.findFirst({ where: { trackerId: tracker.id, status: "running" }, orderBy: { startedAt: "desc" } }),
			prisma.run.findFirst({ where: { trackerId: tracker.id }, orderBy: { startedAt: "desc" }, include: { report: { select: { items: { select: { section: true } } } } } }),
		]);
		return {
			tracker: {
				id: tracker.id,
				name: tracker.name,
				config: publicConfig(tracker.activeConfig as TrackerConfig | null),
				configHash: tracker.configHash,
				comparisonKey: tracker.comparisonKey,
				updatedAt: tracker.updatedAt.toISOString(),
			},
			runInProgress: running ? { id: running.id, startedAt: running.startedAt.toISOString(), lastEventAt: running.lastEventAt.toISOString(), phase: running.phase, cancelRequested: running.cancelRequested } : null,
			latestRun: latest ? runSummary(latest) : null,
		};
	},

	async importConfig(profileId: string, rawConfig: unknown) {
		const parsed = trackerConfigSchema.safeParse(rawConfig);
		if (!parsed.success) {
			throw errors.badRequest("Invalid tracker config.", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
		}
		const config = parsed.data;
		const tracker = await trackerFor(profileId);
		const hash = configHash(config);
		const key = comparisonKey(config);
		await prisma.$transaction(async (tx) => {
			await tx.tracker.update({ where: { id: tracker.id }, data: { name: config.tracker.name, activeConfig: json(config), configHash: hash, comparisonKey: key } });
			for (const company of config.companies) {
				const data = {
					companyName: company.name,
					careersUrl: company.careers_url,
					adapter: company.adapter,
					boardToken: company.board_token ?? null,
					allowedHosts: json(config.fetch_policy.allowed_hosts),
					permissionNotes: company.permission_notes ?? null,
					enabled: true,
				};
				await tx.companySource.upsert({ where: { trackerId_key: { trackerId: tracker.id, key: company.id } }, create: { trackerId: tracker.id, key: company.id, ...data }, update: data });
			}
			await tx.companySource.updateMany({ where: { trackerId: tracker.id, key: { notIn: config.companies.map((company) => company.id) } }, data: { enabled: false } });
		});
		return { configHash: hash, comparisonKey: key };
	},

	async startRun(profileId: string, idempotencyKey: string): Promise<StartRunResponse & { created: boolean }> {
		const tracker = await trackerFor(profileId);
		if (!tracker.activeConfig || !tracker.configHash || !tracker.comparisonKey) {
			throw errors.conflict("NO_CONFIG", "Import config.yaml before starting a run.");
		}
		const now = new Date();
		return prisma.$transaction(async (tx) => {
			// Serialize run creation per tracker so two starts cannot both see "no run in progress".
			await tx.$queryRaw`SELECT id FROM "Tracker" WHERE id = ${tracker.id}::uuid FOR UPDATE`;

			const existing = await tx.run.findUnique({ where: { trackerId_idempotencyKey: { trackerId: tracker.id, idempotencyKey } } });
			if (existing) return { runId: existing.id, status: existing.status, baselineRunId: existing.baselineRunId, abandonedRunIds: [], created: false };

			const stale = await tx.run.findMany({ where: { trackerId: tracker.id, status: "running", lastEventAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } }, select: { id: true } });
			if (stale.length) {
				await tx.run.updateMany({
					where: { id: { in: stale.map((run) => run.id) } },
					data: { status: "partial", partial: true, finishedAt: now, stopReason: "abandoned: no activity for 10 minutes", errorCode: "abandoned" },
				});
			}
			const running = await tx.run.findFirst({ where: { trackerId: tracker.id, status: "running" } });
			if (running) throw errors.conflict("RUN_IN_PROGRESS", `Run ${running.id} is still in progress.`);

			const baseline = await tx.run.findFirst({
				where: { trackerId: tracker.id, status: "complete", comparisonKey: tracker.comparisonKey!, report: { isNot: null } },
				orderBy: { startedAt: "desc" },
			});
			const run = await tx.run.create({
				data: {
					trackerId: tracker.id,
					idempotencyKey,
					configSnapshot: tracker.activeConfig as Prisma.InputJsonValue,
					configHash: tracker.configHash!,
					comparisonKey: tracker.comparisonKey!,
					baselineRunId: baseline?.id ?? null,
					kind: "orchestrated",
					phase: "starting",
				},
			});
			return { runId: run.id, status: run.status, baselineRunId: baseline?.id ?? null, abandonedRunIds: stale.map((row) => row.id), created: true };
		});
	},

	/**
	 * POST /runs: re-read and import config.yaml, create the run, and start the orchestrator in the
	 * background. The same idempotencyKey returns the same run and never starts it twice.
	 */
	async launchRun(profileId: string, idempotencyKey: string, runner: JobRunner): Promise<StartRunResponse> {
		const missing = runner.missingTokens();
		if (missing.length) throw new AppError(503, "WORKERS_NOT_CONFIGURED", `Set ${missing.join(" and ")} in backend/.env.local and restart the API (see backend/.env.example).`);
		if (runner.settings.configPath) {
			let config: TrackerConfig;
			try {
				config = loadConfig(runner.settings.configPath);
			} catch (error) {
				if (error instanceof ConfigError) throw new AppError(400, "CONFIG_INVALID", error.message);
				throw error;
			}
			await this.importConfig(profileId, config);
		}
		const { created, ...started } = await this.startRun(profileId, idempotencyKey);
		if (created) void runner.start(started.runId);
		return started;
	},

	/** Stops the request in flight now and makes the run write a partial report ("cancelled from the dashboard"). */
	async cancelRun(profileId: string, runId: string, runner: JobRunner) {
		const run = await ownedRun(profileId, runId);
		if (run.status !== "running") throw errors.conflict("RUN_NOT_RUNNING", `Run ${run.id} has already finished (${run.status}).`);
		await prisma.run.update({ where: { id: run.id }, data: { cancelRequested: true, lastEventAt: new Date() } });
		const stoppedNow = runner.cancel(run.id);
		return { runId: run.id, cancelRequested: true, stoppedNow };
	},

	async listClaims(profileId: string, runId: string, label: ClaimLabelValue | undefined) {
		await ownedRun(profileId, runId);
		const rows = await prisma.claim.findMany({ where: { runId, ...(label ? { label } : {}) }, include: { reportItem: { select: { rank: true } } } });
		rows.sort((a, b) => (a.reportItem?.rank ?? 99) - (b.reportItem?.rank ?? 99) || a.claimId.localeCompare(b.claimId, undefined, { numeric: true }));
		const counts = Object.fromEntries(claimLabels.map((value) => [value, 0])) as Record<ClaimLabelValue, number>;
		for (const row of await prisma.claim.groupBy({ by: ["label"], where: { runId }, _count: { _all: true } })) counts[row.label] = row._count._all;
		return {
			claims: rows.map((row) => ({
				claimId: row.claimId,
				developmentId: row.developmentId,
				rank: row.reportItem?.rank ?? null,
				text: row.text,
				sourceUrl: row.sourceUrl,
				label: row.label,
				evidence: row.evidence,
				verifyRequestId: row.verifyRequestId,
			})),
			counts,
		};
	},

	/** Both workers' /healthz, probed by the server with a short timeout. */
	async workers(runner: JobRunner) {
		const [researcher, verifier] = await Promise.all([runner.probe("researcher", 3_000), runner.probe("verifier", 3_000)]);
		return { researcher, verifier, checkedAt: new Date().toISOString() };
	},

	/** Wakes the verifier (Render's free tier sleeps after 15 idle minutes) and reports how long it took. */
	async wakeVerifier(profileId: string, runner: JobRunner) {
		const tracker = await trackerFor(profileId);
		const parsed = trackerConfigSchema.safeParse(tracker.activeConfig);
		const timeoutMs = parsed.success ? parsed.data.orchestration.timeouts.healthz_wake_ms : ORCHESTRATION_DEFAULTS.timeouts.healthz_wake_ms;
		return { verifier: await runner.probe("verifier", timeoutMs), timeoutMs };
	},

	async listRuns(profileId: string, cursor: string | undefined, limit: number) {
		const tracker = await trackerFor(profileId);
		await finalizeStale(tracker.id, new Date());
		const take = Math.min(Math.max(limit, 1), 50);
		const runs = await prisma.run.findMany({
			where: { trackerId: tracker.id },
			orderBy: [{ startedAt: "desc" }, { id: "desc" }],
			take: take + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			include: { report: { select: { items: { select: { section: true } } } }, _count: { select: { fetchAttempts: true } } },
		});
		const page = runs.slice(0, take);
		const counts = await claimCountsFor(page.filter((run) => run.kind === "orchestrated").map((run) => run.id));
		return { runs: page.map((run) => runSummary(run, counts.get(run.id))), nextCursor: runs.length > take ? page.at(-1)!.id : null };
	},

	async getRun(profileId: string, runId: string) {
		const run = await ownedRun(profileId, runId);
		const withReport = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { report: { select: { items: { select: { section: true } } } } } });
		const attempts = await prisma.fetchAttempt.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
		const workerCalls = await prisma.workerCall.findMany({ where: { runId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] });
		return {
			run: {
				...runSummary(withReport, run.kind === "orchestrated" ? ((await claimCountsFor([run.id])).get(run.id) ?? { supported: 0, unsupported: 0, unreachable: 0, unverified: 0 }) : undefined),
				config: publicConfig(run.configSnapshot as TrackerConfig),
				attemptCounts: Object.fromEntries(attempts.map((row) => [row.status, row._count._all])),
				ledger: run.ledger,
				workerCalls: workerCalls.map(workerCallDto),
			},
		};
	},

	async getReport(profileId: string, runId: string) {
		await ownedRun(profileId, runId);
		const report = await prisma.report.findUnique({ where: { runId } });
		if (!report) throw Object.assign(errors.notFound("This run has no report yet."), { code: "REPORT_NOT_READY" });
		return { report: report.reportJson as ReportJson, markdown: report.markdown, status: report.status, createdAt: report.createdAt.toISOString() };
	},

	async latestReport(profileId: string) {
		const tracker = await trackerFor(profileId);
		const run = await prisma.run.findFirst({ where: { trackerId: tracker.id, report: { isNot: null } }, orderBy: { startedAt: "desc" }, include: { report: true } });
		if (!run?.report) return { run: null, report: null };
		return { run: runSummary({ ...run, report: { items: [] } }), report: run.report.reportJson as ReportJson };
	},

	async listSources(profileId: string, runId: string, cursor: string | undefined, limit: number) {
		await ownedRun(profileId, runId);
		const take = Math.min(Math.max(limit, 1), 200);
		const rows = await prisma.fetchAttempt.findMany({
			where: { runId },
			orderBy: [{ attemptedAt: "asc" }, { id: "asc" }],
			take: take + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			include: { sourceDocument: { select: { title: true, fetchedAt: true, finalUrl: true } } },
		});
		const page = rows.slice(0, take);
		return {
			sources: page.map((row) => ({
				id: row.id,
				requestedUrl: row.requestedUrl,
				canonicalUrl: row.canonicalUrl,
				finalUrl: row.sourceDocument?.finalUrl ?? null,
				title: row.title ?? row.sourceDocument?.title ?? null,
				status: row.status,
				reason: row.reason,
				attemptedAt: row.attemptedAt.toISOString(),
				fetchedAt: row.sourceDocument?.fetchedAt.toISOString() ?? null,
				latencyMs: row.latencyMs,
				bytes: row.bytes,
				retryCount: row.retryCount,
			})),
			nextCursor: rows.length > take ? page.at(-1)!.id : null,
		};
	},

	async listTrace(profileId: string, runId: string, cursor: string | undefined, limit: number) {
		await ownedRun(profileId, runId);
		const take = Math.min(Math.max(limit, 1), 500);
		const rows = await prisma.traceEvent.findMany({
			where: { runId },
			orderBy: [{ startedAt: "asc" }, { id: "asc" }],
			take: take + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		});
		const page = rows.slice(0, take);
		return {
			events: page.map((row) => ({
				id: row.id,
				eventId: row.eventId,
				parentEventId: row.parentEventId,
				step: row.step,
				category: row.category,
				service: row.service,
				tool: row.tool,
				arguments: row.argumentsRedacted,
				status: row.status,
				startedAt: row.startedAt.toISOString(),
				latencyMs: row.latencyMs,
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				searchCredits: row.searchCredits,
				errorCode: row.errorCode,
				detail: row.detail,
			})),
			nextCursor: rows.length > take ? page.at(-1)!.id : null,
		};
	},

	async reset(profileId: string, confirm: unknown) {
		if (serverEnv().APP_ENV === "production") throw errors.notFound("Route not found.");
		if (confirm !== "intersearch-development") throw errors.badRequest('Pass {"confirm": "intersearch-development"} to reset tracker history.');
		const tracker = await trackerFor(profileId);
		const [runs, opportunities, documents] = await prisma.$transaction([
			prisma.run.deleteMany({ where: { trackerId: tracker.id } }),
			prisma.opportunity.deleteMany({ where: { trackerId: tracker.id } }),
			prisma.sourceDocument.deleteMany({ where: { trackerId: tracker.id } }),
		]);
		return { deleted: { runs: runs.count, opportunities: opportunities.count, documents: documents.count } };
	},
};
