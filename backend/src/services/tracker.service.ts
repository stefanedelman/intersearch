import { prisma } from "../lib/prisma";
import { errors } from "../lib/errors";
import { serverEnv } from "../lib/env";
import { Prisma } from "../generated/prisma/client";
import type { Run, Tracker } from "../generated/prisma/client";
import { comparisonKey, configHash, trackerConfigSchema, type TrackerConfig } from "../tracker/config";
import { quoteAppearsIn } from "../tracker/domain/normalize";
import type { CheckpointBody, FinalizeBody, StartRunResponse, TrackerStateDto } from "../contracts/tracker";
import type { EvidenceRef, ReportJson } from "../contracts/report";

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
	};
}

function runSummary(run: Run & { report?: { items: { section: string }[] } | null; _count?: { fetchAttempts: number } }) {
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
			runInProgress: running ? { id: running.id, startedAt: running.startedAt.toISOString(), lastEventAt: running.lastEventAt.toISOString() } : null,
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

	async startRun(profileId: string, idempotencyKey: string): Promise<StartRunResponse> {
		const tracker = await trackerFor(profileId);
		if (!tracker.activeConfig || !tracker.configHash || !tracker.comparisonKey) {
			throw errors.conflict("NO_CONFIG", "Import config.yaml before starting a run.");
		}
		const now = new Date();
		return prisma.$transaction(async (tx) => {
			// Serialize run creation per tracker so two starts cannot both see "no run in progress".
			await tx.$queryRaw`SELECT id FROM "Tracker" WHERE id = ${tracker.id}::uuid FOR UPDATE`;

			const existing = await tx.run.findUnique({ where: { trackerId_idempotencyKey: { trackerId: tracker.id, idempotencyKey } } });
			if (existing) return { runId: existing.id, status: "running" as const, baselineRunId: existing.baselineRunId, abandonedRunIds: [] };

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
				},
			});
			return { runId: run.id, status: "running" as const, baselineRunId: baseline?.id ?? null, abandonedRunIds: stale.map((row) => row.id) };
		});
	},

	async state(profileId: string, runId?: string): Promise<TrackerStateDto> {
		const tracker = await trackerFor(profileId);
		const run = runId ? await ownedRun(profileId, runId) : null;
		const key = run?.comparisonKey ?? tracker.comparisonKey;

		const baselineRun = run
			? run.baselineRunId
				? await prisma.run.findUnique({ where: { id: run.baselineRunId }, include: { report: { include: { items: { include: { opportunity: true } } } } } })
				: null
			: key
				? await prisma.run.findFirst({ where: { trackerId: tracker.id, status: "complete", comparisonKey: key, report: { isNot: null } }, orderBy: { startedAt: "desc" }, include: { report: { include: { items: { include: { opportunity: true } } } } } })
				: null;

		const anyComplete = await prisma.run.count({ where: { trackerId: tracker.id, status: "complete", id: run ? { not: run.id } : undefined } });

		const documents = await prisma.sourceDocument.findMany({
			where: { trackerId: tracker.id },
			orderBy: { fetchedAt: "desc" },
			take: 1000,
			select: { id: true, canonicalUrl: true, title: true, fetchedAt: true, contentHash: true },
		});
		const latestPerUrl = new Map<string, (typeof documents)[number]>();
		for (const doc of documents) if (!latestPerUrl.has(doc.canonicalUrl)) latestPerUrl.set(doc.canonicalUrl, doc);

		const opportunities = await prisma.opportunity.findMany({
			where: { trackerId: tracker.id },
			orderBy: { lastSeenAt: "desc" },
			take: 300,
			include: {
				observations: { orderBy: { observedAt: "desc" }, take: 1 },
				sources: { include: { sourceDocument: { select: { id: true, finalUrl: true, title: true, fetchedAt: true } } }, take: 10 },
			},
		});

		return {
			trackerId: tracker.id,
			comparisonKey: key ?? null,
			comparisonReset: !baselineRun && anyComplete > 0,
			baseline: baselineRun?.report
				? {
						runId: baselineRun.id,
						items: baselineRun.report.items
							.filter((item) => item.section !== "dropped")
							.map((item) => ({ identityKey: item.opportunity.identityKey, rank: item.rank, company: item.opportunity.companyName, title: item.opportunity.title })),
					}
				: null,
			documents: [...latestPerUrl.values()].map((doc) => ({ ...doc, fetchedAt: doc.fetchedAt.toISOString() })),
			opportunities: opportunities.map((opportunity) => {
				const last = opportunity.observations[0];
				return {
					id: opportunity.id,
					identityKey: opportunity.identityKey,
					companyName: opportunity.companyName,
					title: opportunity.title,
					providerJobId: opportunity.providerJobId,
					firstSeenAt: opportunity.firstSeenAt.toISOString(),
					lastSeenAt: opportunity.lastSeenAt.toISOString(),
					firstReportedAt: opportunity.firstReportedAt?.toISOString() ?? null,
					lastObservation: last
						? {
								facts: last.extractedFacts as Record<string, unknown>,
								evidence: last.evidenceReferences as EvidenceRef[],
								sources: opportunity.sources.map((source) => ({
									sourceDocumentId: source.sourceDocument.id,
									url: source.sourceDocument.finalUrl,
									title: source.sourceDocument.title,
									fetchedAt: source.sourceDocument.fetchedAt.toISOString(),
								})),
							}
						: null,
				};
			}),
		};
	},

	async document(profileId: string, documentId: string) {
		const tracker = await trackerFor(profileId);
		const doc = await prisma.sourceDocument.findFirst({ where: { id: documentId, trackerId: tracker.id } });
		if (!doc) throw errors.notFound("Document not found.");
		return {
			id: doc.id,
			canonicalUrl: doc.canonicalUrl,
			finalUrl: doc.finalUrl,
			sourceKind: doc.sourceKind,
			title: doc.title,
			text: doc.text,
			contentHash: doc.contentHash,
			httpStatus: doc.httpStatus,
			metadata: doc.metadata as Record<string, unknown> | null,
			fetchedAt: doc.fetchedAt.toISOString(),
		};
	},

	async checkpoint(profileId: string, runId: string, body: CheckpointBody) {
		const run = await ownedRun(profileId, runId);
		const hasReport = await prisma.report.count({ where: { runId } });
		if (hasReport) throw errors.conflict("RUN_FINALIZED", "This run is already finalized.");

		const documentIds: Record<string, string> = {};
		for (const doc of body.documents) {
			const saved = await prisma.sourceDocument.upsert({
				where: { trackerId_canonicalUrl_contentHash: { trackerId: run.trackerId, canonicalUrl: doc.canonicalUrl, contentHash: doc.contentHash } },
				create: { ...doc, metadata: doc.metadata ? json(doc.metadata) : Prisma.JsonNull, trackerId: run.trackerId, fetchedAt: new Date(doc.fetchedAt) },
				update: {},
				select: { id: true },
			});
			documentIds[doc.id] = saved.id;
		}

		const remap = (id: string | null) => (id ? (documentIds[id] ?? id) : null);
		const attemptDocIds = body.fetchAttempts.map((attempt) => remap(attempt.sourceDocumentId)).filter((id): id is string => Boolean(id));
		const ownedDocs = new Set(
			(await prisma.sourceDocument.findMany({ where: { id: { in: attemptDocIds }, trackerId: run.trackerId }, select: { id: true } })).map((doc) => doc.id),
		);

		if (body.fetchAttempts.length) {
			await prisma.fetchAttempt.createMany({
				skipDuplicates: true,
				data: body.fetchAttempts.map((attempt) => {
					const docId = remap(attempt.sourceDocumentId);
					return { ...attempt, runId, sourceDocumentId: docId && ownedDocs.has(docId) ? docId : null, attemptedAt: new Date(attempt.attemptedAt) };
				}),
			});
		}
		if (body.events.length) {
			await prisma.traceEvent.createMany({
				skipDuplicates: true,
				data: body.events.map((event) => ({
					runId,
					eventId: event.eventId,
					parentEventId: event.parentEventId,
					step: event.step,
					category: event.category,
					service: event.service,
					tool: event.tool,
					argumentsRedacted: event.arguments === null || event.arguments === undefined ? Prisma.JsonNull : json(event.arguments),
					status: event.status,
					startedAt: new Date(event.startedAt),
					latencyMs: event.latencyMs,
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					searchCredits: event.searchCredits,
					estimatedCost: event.estimatedCost,
					errorCode: event.errorCode,
					detail: event.detail === null || event.detail === undefined ? Prisma.JsonNull : json(event.detail),
				})),
			});
		}
		if (run.status === "running") await prisma.run.update({ where: { id: runId }, data: { lastEventAt: new Date() } });
		return { documentIds };
	},

	async finalize(profileId: string, runId: string, body: FinalizeBody) {
		const run = await ownedRun(profileId, runId);
		const existing = await prisma.report.findUnique({ where: { runId } });
		if (existing) return { reportId: existing.id, alreadyFinalized: true };
		if (body.report.runId !== runId) throw errors.badRequest("Report runId does not match.");

		const config = run.configSnapshot as TrackerConfig;
		if (body.report.items.length > config.tracker.k) throw errors.badRequest(`Report has more than K=${config.tracker.k} items.`);
		const ranks = body.report.items.map((item) => item.rank);
		if (new Set(ranks).size !== ranks.length) throw errors.badRequest("Report ranks must be unique.");

		// Provenance: every cited document must belong to this tracker, and every quote must
		// actually occur in that document's stored text.
		const citedIds = new Set<string>();
		const allEvidence: EvidenceRef[] = [];
		for (const observation of body.observations) {
			observation.sourceDocumentIds.forEach((id) => citedIds.add(id));
			allEvidence.push(...observation.evidence);
		}
		for (const item of body.report.items) {
			item.sources.forEach((source) => citedIds.add(source.sourceDocumentId));
			allEvidence.push(...item.evidence);
		}
		allEvidence.forEach((evidence) => citedIds.add(evidence.sourceDocumentId));
		const docs = await prisma.sourceDocument.findMany({ where: { id: { in: [...citedIds] }, trackerId: run.trackerId }, select: { id: true, text: true, title: true } });
		const docById = new Map(docs.map((doc) => [doc.id, doc]));
		const missing = [...citedIds].filter((id) => !docById.has(id));
		if (missing.length) throw errors.badRequest("Report cites documents that do not belong to this tracker.", { missing: missing.slice(0, 5) });

		const unsupported = allEvidence.filter((evidence) => {
			const doc = docById.get(evidence.sourceDocumentId)!;
			// The page title is part of the fetched document, so a quote may come from it too.
			return !(quoteAppearsIn(evidence.quote, doc.text) || (doc.title && quoteAppearsIn(evidence.quote, doc.title)));
		});
		if (unsupported.length) {
			throw errors.badRequest("Some cited quotes do not appear in their source documents.", unsupported.slice(0, 5).map((evidence) => ({ field: evidence.field, quote: evidence.quote })));
		}
		for (const item of body.report.items) {
			if (item.agentNote && !item.sources.some((source) => quoteAppearsIn(item.agentNote!.quote, docById.get(source.sourceDocumentId)!.text))) {
				throw errors.badRequest("An agent note quote does not appear in its item's sources.");
			}
		}

		const now = new Date();
		const report = await prisma.$transaction(
			async (tx) => {
				const companies = await tx.companySource.findMany({ where: { trackerId: run.trackerId } });
				const companyIdByKey = new Map(companies.map((company) => [company.key, company.id]));
				const opportunityIdByKey = new Map<string, string>();

				for (const observation of body.observations) {
					const data = {
						companySourceId: observation.companyId ? (companyIdByKey.get(observation.companyId) ?? null) : null,
						companyName: observation.companyName,
						provider: observation.identityMethod === "provider_id" ? "greenhouse" : null,
						providerJobId: observation.providerJobId,
						title: observation.title,
						normalizedTitle: observation.normalizedTitle,
						locationKey: observation.locationKey,
						season: observation.season,
						applicationUrl: observation.applicationUrl,
					};
					const opportunity = await tx.opportunity.upsert({
						where: { trackerId_identityKey: { trackerId: run.trackerId, identityKey: observation.identityKey } },
						create: { trackerId: run.trackerId, identityKey: observation.identityKey, ...data, firstSeenAt: now, lastSeenAt: now },
						update: observation.reverified ? { ...data, lastSeenAt: now } : {},
					});
					opportunityIdByKey.set(observation.identityKey, opportunity.id);
					for (const sourceDocumentId of observation.sourceDocumentIds) {
						await tx.opportunitySource.upsert({
							where: { opportunityId_sourceDocumentId: { opportunityId: opportunity.id, sourceDocumentId } },
							create: { opportunityId: opportunity.id, sourceDocumentId, relation: "supports", dedupeMethod: observation.identityMethod, confidence: observation.identityMethod === "provider_id" ? 1 : 0.7 },
							update: {},
						});
					}
					if (observation.reverified) {
						await tx.opportunityObservation.upsert({
							where: { runId_opportunityId: { runId, opportunityId: opportunity.id } },
							create: { runId, opportunityId: opportunity.id, extractedFacts: json(observation.facts), evidenceReferences: json(observation.evidence) },
							update: {},
						});
					}
				}

				const keys = [...body.report.items.map((item) => item.identityKey), ...body.report.dropped.map((item) => item.identityKey)];
				const missingKeys = keys.filter((key) => !opportunityIdByKey.has(key));
				if (missingKeys.length) {
					const found = await tx.opportunity.findMany({ where: { trackerId: run.trackerId, identityKey: { in: missingKeys } }, select: { id: true, identityKey: true } });
					found.forEach((opportunity) => opportunityIdByKey.set(opportunity.identityKey, opportunity.id));
				}

				const created = await tx.report.create({
					data: {
						runId,
						status: body.status,
						reportJson: json(body.report satisfies ReportJson),
						markdown: body.markdown,
						previousCompleteRunId: run.baselineRunId,
					},
				});
				const itemRows = [
					...body.report.items.map((item) => ({
						reportId: created.id,
						opportunityId: opportunityIdByKey.get(item.identityKey),
						rank: item.rank,
						section: item.section,
						score: item.score,
						scoreBreakdown: json(item.breakdown),
						summary: item.summary,
						evidenceReferences: json(item.evidence),
					})),
					...body.report.dropped.map((item) => ({
						reportId: created.id,
						opportunityId: opportunityIdByKey.get(item.identityKey),
						rank: null,
						section: "dropped" as const,
						score: 0,
						scoreBreakdown: json({}),
						summary: item.reason,
						evidenceReferences: json([]),
					})),
				].filter((row): row is typeof row & { opportunityId: string } => Boolean(row.opportunityId));
				if (itemRows.length) await tx.reportItem.createMany({ data: itemRows, skipDuplicates: true });

				// Only complete runs count as "reported", so a partial run cannot make a role look
				// like it "returned" later.
				if (body.status === "complete") {
					const reportedIds = body.report.items.map((item) => opportunityIdByKey.get(item.identityKey)).filter((id): id is string => Boolean(id));
					await tx.opportunity.updateMany({ where: { id: { in: reportedIds }, firstReportedAt: null }, data: { firstReportedAt: now } });
				}

				await tx.run.update({
					where: { id: runId },
					data: {
						status: body.status,
						partial: body.status !== "complete",
						finishedAt: run.finishedAt ?? now,
						stopReason: body.stopReason ?? run.stopReason,
						errorCode: body.errorCode ?? (run.errorCode === "abandoned" ? "abandoned" : null),
						budgetTotals: json(body.budgetTotals),
						lastEventAt: now,
					},
				});
				return created;
			},
			{ timeout: 30_000 },
		);
		return { reportId: report.id, alreadyFinalized: false };
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
		return { runs: page.map(runSummary), nextCursor: runs.length > take ? page.at(-1)!.id : null };
	},

	async getRun(profileId: string, runId: string) {
		const run = await ownedRun(profileId, runId);
		const withReport = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { report: { select: { items: { select: { section: true } } } } } });
		const attempts = await prisma.fetchAttempt.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } });
		return {
			run: {
				...runSummary(withReport),
				config: publicConfig(run.configSnapshot as TrackerConfig),
				attemptCounts: Object.fromEntries(attempts.map((row) => [row.status, row._count._all])),
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
