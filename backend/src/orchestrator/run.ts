import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
	checkResearchResult,
	checkVerdicts,
	researchResponseSchema,
	verifyResponseSchema,
	type CheckResult,
	type Development,
	type ResearchResult,
	type VerifyResult,
	type WorkerService,
} from "../shared/contract";
import { configHash, trackerConfigSchema } from "../shared/config";
import { TraceLog } from "../shared/trace-log";
import type { ReportJsonV2 } from "../contracts/report";
import { Ledger, researcherShare, toBudget, verifierShare, type Dimensions } from "./ledger";
import { createCall, finishCall, heartbeat, loadRunContext, markFailed, markStarted, recordAttempts, saveReport, setPhase, type CallOutcome } from "./persist";
import { buildReport, renderMarkdown, type Verdicts, type WorkerState } from "./report";
import { FAILURES, interpretCall } from "./interpret";
import { createWorkerClient, type AttemptRecord, type WorkerClient, type WorkerClientOptions } from "./worker-client";

/**
 * One orchestrated run, start to finish (ORCHESTRATION_PLAN.md §6):
 * wake the verifier → research → verify each development → report → persist → collect traces.
 *
 * Routing depends only on HTTP status codes, the validated `status` enum, and ledger numbers;
 * worker-written text (titles, summaries, claims, evidence, error messages) is stored and shown,
 * never acted on. Every failure ends in a saved report that names it.
 */

export type WorkerEndpoint = { url: string; token: string };

export type OrchestratorDeps = {
	researcher: WorkerEndpoint;
	verifier: WorkerEndpoint;
	/** Tests: a fake dispatcher, deterministic jitter, fast waits. */
	clientOptions?: Pick<WorkerClientOptions, "dispatcher" | "random" | "sleep">;
	/** runs/<runId>/ receives orchestrator.jsonl, report.md, researcher.jsonl, verifier.jsonl. */
	runsDir: string;
	/** How often the run's lastEventAt is refreshed and cancelRequested is checked. */
	heartbeatMs?: number;
	/** Timeout for GET /trace when collecting worker traces after the run. */
	traceTimeoutMs?: number;
};

/** A worker cannot do anything useful in less than this; a shorter time budget is not sent. */
const MIN_TIME_BUDGET_MS = 1_000;

export async function runOrchestration(deps: OrchestratorDeps, runId: string, externalSignal?: AbortSignal): Promise<void> {
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	if (externalSignal?.aborted) controller.abort();
	externalSignal?.addEventListener("abort", forwardAbort, { once: true });
	const signal = controller.signal;
	const cancelled = () => signal.aborted;

	const dir = path.join(deps.runsDir, runId);
	const log = new TraceLog("orchestrator", { file: path.join(dir, "orchestrator.jsonl") });
	const startedAt = Date.now();
	let step = 0;
	const nextStep = () => ++step;
	let saved = false;
	let context: Awaited<ReturnType<typeof loadRunContext>> | null = null;
	let ledger: Ledger | null = null;
	let wake: Promise<unknown> = Promise.resolve();
	let clients: { researcher: WorkerClient; verifier: WorkerClient } | null = null;
	const wakeController = new AbortController();
	const timer = setInterval(() => {
		heartbeat(runId)
			.then((requested) => {
				if (requested) controller.abort();
			})
			.catch(() => undefined);
	}, deps.heartbeatMs ?? 15_000);
	timer.unref();

	try {
		context = await loadRunContext(runId);
		const { run, baseline, everReported } = context;
		const config = trackerConfigSchema.parse(run.configSnapshot);
		const orch = config.orchestration;
		const deadlineAt = startedAt + orch.run_deadline_ms;
		const grace = orch.timeouts.grace_ms;
		const k = config.tracker.k;
		const workerClient = (service: WorkerService) => createWorkerClient({ service, baseUrl: deps[service].url, token: deps[service].token, retries: orch.retries, ...deps.clientOptions });
		clients = { researcher: workerClient("researcher"), verifier: workerClient("verifier") };
		const { researcher, verifier } = clients;
		const runLedger = Ledger.fromConfig(orch);
		ledger = runLedger;
		await markStarted(runId, baseline?.runId ?? null);

		// --- 1. Wake the verifier while research runs (Render's free tier sleeps after 15 idle minutes).
		let verifierWarm = false;
		const wakeStep = nextStep();
		wake = (async () => {
			const requestId = randomUUID();
			await createCall({ runId, requestId, service: "verifier", endpoint: "/healthz", share: { timeout_ms: orch.timeouts.healthz_wake_ms } });
			const probe = await verifier.healthz({ log, runId, step: wakeStep, timeoutMs: orch.timeouts.healthz_wake_ms, signal: AbortSignal.any([signal, wakeController.signal]) });
			verifierWarm ||= probe.up;
			const attempt: AttemptRecord = { attempt: 1, startedAt: probe.startedAt.toISOString(), status: probe.status, latencyMs: probe.latencyMs, waitMs: null, retryAfterMs: null, errorCode: probe.up ? null : String(probe.status) };
			await finishCall(runId, requestId, {
				outcome: probe.up ? "complete" : "unanswered",
				attempts: [attempt],
				latencyMs: probe.latencyMs,
				reportedUsage: null,
				chargedUsage: null,
				errorCode: probe.up ? null : String(probe.status),
				errorMessage: probe.up ? null : `verifier /healthz: ${probe.status}`,
			});
		})().catch(() => undefined);

		/** Reserve, record, send (with retries), validate, charge once, record. */
		async function send<R>(input: {
			client: WorkerClient;
			service: WorkerService;
			path: "/research" | "/verify";
			payload: unknown;
			share: Dimensions;
			timeBudgetMs: number;
			attemptTimeoutMs: number;
			schema: z.ZodType<unknown>;
			check: (result: R) => CheckResult;
		}) {
			const requestId = randomUUID();
			const envelope = { request_id: requestId, run_id: runId, time_budget_ms: input.timeBudgetMs, budget: toBudget(input.share), payload: input.payload };
			const body = JSON.stringify(envelope); // serialised once: every retry sends these exact bytes
			runLedger.reserve(requestId, input.service, input.share);
			await createCall({ runId, requestId, service: input.service, endpoint: input.path, share: { time_budget_ms: input.timeBudgetMs, budget: envelope.budget, attempt_timeout_ms: input.attemptTimeoutMs } });
			const attempts: AttemptRecord[] = [];
			const callStep = nextStep();
			const call = await input.client.post({
				path: input.path,
				body,
				runId,
				requestId,
				step: callStep,
				log,
				attemptTimeoutMs: input.attemptTimeoutMs,
				deadlineAt,
				signal,
				onAttempt: async (record) => {
					attempts.push(record);
					await recordAttempts(requestId, attempts).catch(() => undefined);
				},
			});
			const interpreted = interpretCall<R>(call, input.schema, { requestId, runId }, input.check);
			const entry = runLedger.charge(requestId, interpreted.basis === "reported" ? interpreted.usage : null, interpreted.basis === "none" ? "none" : undefined);
			log.write({
				run_id: runId,
				request_id: requestId,
				step: callStep,
				direction: "out",
				endpoint_or_tool: "ledger charge",
				status: entry.overrun ? "budget_overrun" : entry.basis!,
				latency_ms: null,
				attempt: call.attempts.length,
				tokens: entry.charged!.tokens,
				detail: { share: entry.share, charged: entry.charged, remaining: runLedger.remaining },
			});
			await finishCall(runId, requestId, {
				outcome: interpreted.outcome,
				attempts: call.attempts,
				latencyMs: call.latencyMs,
				reportedUsage: interpreted.usage,
				chargedUsage: { ...entry.charged, basis: entry.basis, overrun: entry.overrun },
				errorCode: interpreted.errorCode,
				errorMessage: interpreted.errorMessage,
			});
			return { requestId, interpreted, call };
		}

		async function refuse(service: WorkerService, endpoint: string, share: Dimensions | null, errorCode: string, errorMessage: string) {
			await createCall({ runId, requestId: randomUUID(), service, endpoint, share: { budget: share ? toBudget(share) : null }, outcome: "refused_budget", errorCode, errorMessage });
			log.write({ run_id: runId, request_id: null, step: nextStep(), direction: "out", endpoint_or_tool: `POST ${service} ${endpoint}`, status: "not_sent", latency_ms: null, attempt: 0, tokens: null, error_code: errorCode, detail: { reason: errorMessage } });
		}

		// --- 2. Research.
		await setPhase(runId, "researching", runLedger.snapshot());
		const stopReasons: string[] = [];
		let errorCode: string | null = null;
		const flag = (code: string, reason: string) => {
			errorCode ??= code;
			stopReasons.push(reason);
		};

		let developments: Development[] | null = null;
		let researcherState: WorkerState = "skipped";
		const researchTime = Math.min(orch.time_budget_ms.researcher, deadlineAt - Date.now() - grace);
		const rShare = researcherShare(orch);
		if (cancelled()) {
			flag("cancelled", "cancelled from the dashboard");
		} else if (researchTime < MIN_TIME_BUDGET_MS) {
			await refuse("researcher", "/research", rShare, "time_budget_exhausted", "the run deadline leaves no time for research");
			researcherState = "failed";
			flag("researcher_unavailable", "researcher not called: the run deadline leaves no time for research");
		} else {
			const { interpreted } = await send<ResearchResult>({
				client: researcher,
				service: "researcher",
				path: "/research",
				payload: { topic: config.tracker.topic, k },
				share: rShare,
				timeBudgetMs: researchTime,
				attemptTimeoutMs: researchTime + grace,
				schema: researchResponseSchema,
				check: (result) => checkResearchResult(result, k),
			});
			if (interpreted.outcome === "complete" || interpreted.outcome === "partial") {
				developments = interpreted.result!.developments;
				researcherState = interpreted.outcome;
				if (interpreted.outcome === "partial") flag(`researcher_${interpreted.errorCode}`, `researcher stopped early (${interpreted.errorCode}): ${interpreted.errorMessage}`);
			} else if (interpreted.cancelled) {
				flag("cancelled", "cancelled from the dashboard");
			} else {
				researcherState = "failed";
				flag("researcher_unavailable", `researcher unavailable (${interpreted.outcome}): ${interpreted.errorMessage}`);
			}
		}

		// --- 3. Verify: one request per development that has claims, one at a time.
		const verdicts: Verdicts = new Map();
		const verifyRequestByClaim = new Map<string, string>();
		const chunkOutcomes: CallOutcome[] = [];
		let verifierState: WorkerState = "skipped";
		const chunks = (developments ?? []).filter((development) => development.claims.length > 0);
		if (developments === null || chunks.length === 0 || cancelled()) wakeController.abort();
		if (chunks.length && !cancelled()) {
			// verifyChunks lets the dashboard show "Verifying 2/5".
			await setPhase(runId, "verifying", { ...runLedger.snapshot(), verifyChunks: chunks.length });
			await wake;
			let refusedBudget = 0;
			let refusedTime = 0;
			let failureMessage: string | null = null;
			let partialCode: string | null = null;
			for (let index = 0; index < chunks.length; index += 1) {
				if (cancelled()) break;
				const development = chunks[index]!;
				const share = verifierShare(runLedger.remaining, chunks.length - index, orch.min_verify_share);
				const cold = verifierWarm ? 0 : orch.timeouts.verifier_cold_start_ms;
				const timeBudget = Math.min(orch.time_budget_ms.verifier_per_chunk, deadlineAt - Date.now() - grace - cold);
				if (!share) {
					refusedBudget += 1;
					await refuse("verifier", "/verify", null, "budget_exhausted", `not enough budget left for development #${index + 1} (${JSON.stringify(runLedger.remaining)})`);
					continue;
				}
				if (timeBudget < MIN_TIME_BUDGET_MS) {
					refusedTime += 1;
					await refuse("verifier", "/verify", share, "time_budget_exhausted", `the run deadline leaves no time to verify development #${index + 1}`);
					continue;
				}
				const sent = development.claims.map((claim) => ({ claim_id: claim.claim_id, text: claim.text, source_url: claim.source_url }));
				const { requestId, interpreted, call } = await send<VerifyResult>({
					client: verifier,
					service: "verifier",
					path: "/verify",
					payload: { claims: sent },
					share,
					timeBudgetMs: timeBudget,
					attemptTimeoutMs: timeBudget + grace + cold,
					schema: verifyResponseSchema,
					check: (result) => checkVerdicts(result, sent.map((claim) => claim.claim_id)),
				});
				if (call.response) verifierWarm = true;
				if (interpreted.cancelled) break;
				chunkOutcomes.push(interpreted.outcome);
				if (interpreted.outcome === "complete" || interpreted.outcome === "partial") {
					for (const verdict of interpreted.result!.verdicts) {
						verdicts.set(verdict.claim_id, { label: verdict.verdict, evidence: verdict.evidence });
						verifyRequestByClaim.set(verdict.claim_id, requestId);
					}
					if (interpreted.outcome === "partial") partialCode ??= interpreted.errorCode;
				} else {
					failureMessage ??= `${interpreted.outcome}: ${interpreted.errorMessage}`;
				}
			}
			const answered = chunkOutcomes.filter((outcome) => outcome === "complete" || outcome === "partial").length;
			const failed = chunkOutcomes.filter((outcome) => FAILURES.has(outcome)).length;
			verifierState = chunkOutcomes.length === 0 ? "skipped" : answered === 0 ? "failed" : failed === 0 && partialCode === null && chunkOutcomes.length === chunks.length ? "complete" : "partial";
			if (cancelled()) flag("cancelled", "cancelled from the dashboard");
			if (failed) flag("verifier_unavailable", `verifier failed for ${failed} of ${chunks.length} developments (${failureMessage})`);
			if (partialCode) flag(`verifier_${partialCode}`, `verifier stopped early (${partialCode})`);
			if (refusedBudget) flag("budget_exhausted", `budget_exhausted: ${refusedBudget} of ${chunks.length} verify requests not sent`);
			if (refusedTime) flag("run_deadline", `run deadline: ${refusedTime} of ${chunks.length} verify requests not sent`);
		}
		await wake;

		// --- 4. Report.
		await setPhase(runId, "reporting", { ...runLedger.snapshot(), verifyChunks: chunks.length });
		const failedWorkers: ReportJsonV2["failedWorkers"] = [];
		if (researcherState === "failed") failedWorkers.push("researcher");
		if (chunkOutcomes.some((outcome) => FAILURES.has(outcome))) failedWorkers.push("verifier");
		const elapsedMs = Date.now() - startedAt;
		const charged = runLedger.charged;
		let report = buildReport({
			runId,
			status: "complete",
			stopReason: null,
			topic: config.tracker.topic,
			k,
			developments,
			staleBecause: researcherState === "failed" ? "researcher unavailable" : "cancelled before research finished",
			verdicts,
			baseline,
			everReported,
			workers: { researcher: researcherState, verifier: verifierState },
			failedWorkers,
			notes: [],
			stats: { workerCalls: runLedger.snapshot().entries.length, elapsedMs, budget: { total: runLedger.total, charged } },
			now: new Date(),
		});
		const unverified = report.stale ? 0 : report.stats.claims.unverified;
		if (unverified && stopReasons.length === 0) flag("claims_unverified", `${unverified} claims have no verdict`);
		// Failed only when the researcher failed and there is nothing earlier to show; otherwise any stop reason makes it partial.
		const status: ReportJsonV2["status"] = report.stale && report.items.length === 0 && researcherState === "failed" ? "failed" : stopReasons.length ? "partial" : "complete";
		report = { ...report, status, stopReason: stopReasons.length ? stopReasons.join("; ").slice(0, 400) : null };
		const markdown = renderMarkdown(report, { trackerName: config.tracker.name, configHash: configHash(config) });

		await saveReport({
			runId,
			trackerId: run.trackerId,
			report,
			markdown,
			baselineRunId: baseline?.runId ?? null,
			verifyRequestByClaim,
			errorCode,
			ledger: { ...runLedger.snapshot(), verifyChunks: chunks.length },
			budgetTotals: { ...charged, elapsedMs },
		});
		saved = true;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "report.md"), markdown);
	} catch (error) {
		const message = `orchestrator error: ${(error as Error).message ?? String(error)}`;
		log.write({ run_id: runId, request_id: null, step: nextStep(), direction: "out", endpoint_or_tool: "orchestrator", status: "error", latency_ms: null, attempt: 0, tokens: null, error_code: "orchestrator_error", detail: { message: message.slice(0, 300) } });
		wakeController.abort();
		await wake;
		if (!saved && context) {
			try {
				const config = trackerConfigSchema.parse(context.run.configSnapshot);
				const report: ReportJsonV2 = {
					...buildReport({
						runId,
						status: "failed",
						stopReason: message,
						topic: config.tracker.topic,
						k: config.tracker.k,
						developments: [],
						verdicts: new Map(),
						baseline: null,
						everReported: new Set(),
						workers: { researcher: "skipped", verifier: "skipped" },
						failedWorkers: [],
						notes: ["The orchestrator hit an internal error; nothing from this run is usable."],
						stats: { workerCalls: ledger?.snapshot().entries.length ?? 0, elapsedMs: Date.now() - startedAt, budget: { total: ledger?.total ?? { steps: 0, fetches: 0, tokens: 0 }, charged: ledger?.charged ?? { steps: 0, fetches: 0, tokens: 0 } } },
						now: new Date(),
					}),
					comparison: { baselineRunId: null, note: null },
				};
				await saveReport({
					runId,
					trackerId: context.run.trackerId,
					report,
					markdown: renderMarkdown(report, { trackerName: config.tracker.name, configHash: configHash(config) }),
					baselineRunId: null,
					verifyRequestByClaim: new Map(),
					errorCode: "orchestrator_error",
					ledger: ledger?.snapshot() ?? null,
					budgetTotals: { ...(ledger?.charged ?? {}), elapsedMs: Date.now() - startedAt },
				});
				saved = true;
			} catch {
				// fall through to markFailed
			}
		}
		if (!saved) await markFailed(runId, message).catch(() => undefined);
	} finally {
		clearInterval(timer);
		externalSignal?.removeEventListener("abort", forwardAbort);
	}

	// --- 5. Collect worker traces right away (Render's in-memory ring is lost when it sleeps).
	if (clients) await collectTraces(clients, deps.traceTimeoutMs ?? 15_000, runId, dir, log, nextStep);
}

async function collectTraces(clients: { researcher: WorkerClient; verifier: WorkerClient }, timeoutMs: number, runId: string, dir: string, log: TraceLog, nextStep: () => number) {
	fs.mkdirSync(dir, { recursive: true });
	for (const client of [clients.researcher, clients.verifier]) {
		const lines = await client.trace({ log, runId, step: nextStep(), timeoutMs, signal: new AbortController().signal });
		const name = client.service;
		if (lines) fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : ""));
	}
}
