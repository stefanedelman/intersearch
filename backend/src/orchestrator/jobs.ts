import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import type { WorkerService } from "../shared/contract";
import { TraceLog } from "../shared/trace-log";
import { orchestratorEnv } from "./env";
import { runOrchestration, type OrchestratorDeps } from "./run";
import { createWorkerClient, type WorkerClientOptions } from "./worker-client";

/**
 * Runs orchestrated runs in the background of the API process: one job per run, an
 * AbortController per job (cancel stops the request in flight at once), and a startup sweep for
 * runs a previous process left behind.
 */

export type RunnerSettings = {
	researcher: { url: string; token: string | undefined };
	verifier: { url: string; token: string | undefined };
	/** config.yaml, re-read and imported at every run start. Null: use the tracker's stored config (tests). */
	configPath: string | null;
	runsDir: string;
	heartbeatMs?: number;
	traceTimeoutMs?: number;
	clientOptions?: Pick<WorkerClientOptions, "dispatcher" | "random" | "sleep">;
};

export type WorkerHealth = {
	configured: boolean;
	url: string;
	/** asleep: no answer within the probe timeout (a Render free instance spinning up). */
	state: "up" | "down" | "asleep" | "not_configured";
	latencyMs: number | null;
	detail: string | null;
};

export function settingsFromEnv(): RunnerSettings {
	const env = orchestratorEnv();
	return {
		researcher: { url: env.RESEARCHER_URL, token: env.RESEARCHER_TOKEN },
		verifier: { url: env.VERIFIER_URL, token: env.VERIFIER_TOKEN },
		configPath: env.TRACKER_CONFIG_PATH,
		runsDir: env.TRACKER_RUNS_DIR,
	};
}

export function createJobRunner(settings: RunnerSettings) {
	const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
	const probeLog = new TraceLog("orchestrator");

	const missingTokens = () =>
		(["researcher", "verifier"] as const).filter((service) => !settings[service].token).map((service) => (service === "researcher" ? "RESEARCHER_TOKEN" : "VERIFIER_TOKEN"));

	return {
		settings,
		missingTokens,

		/** Starts the run in the background. The returned promise is only for tests and shutdown. */
		start(runId: string): Promise<void> {
			const existing = jobs.get(runId);
			if (existing) return existing.done;
			const controller = new AbortController();
			const deps: OrchestratorDeps = {
				researcher: { url: settings.researcher.url, token: settings.researcher.token ?? "" },
				verifier: { url: settings.verifier.url, token: settings.verifier.token ?? "" },
				runsDir: settings.runsDir,
				heartbeatMs: settings.heartbeatMs,
				traceTimeoutMs: settings.traceTimeoutMs,
				clientOptions: settings.clientOptions,
			};
			const done = runOrchestration(deps, runId, controller.signal)
				.catch((error) => logger.error("Orchestrated run crashed", { runId, error: String((error as Error)?.stack ?? error) }))
				.finally(() => jobs.delete(runId));
			jobs.set(runId, { controller, done });
			return done;
		},

		/** Aborts the job's request in flight now (the run also sees cancelRequested on its next heartbeat). */
		cancel(runId: string): boolean {
			const job = jobs.get(runId);
			if (!job) return false;
			job.controller.abort();
			return true;
		},

		isActive: (runId: string) => jobs.has(runId),

		/** Waits for every job (tests, graceful shutdown). */
		async idle() {
			await Promise.all([...jobs.values()].map((job) => job.done));
		},

		/**
		 * At boot: orchestrated runs still marked running belong to a process that is gone (a crash,
		 * or `tsx watch` restarting on save). Close them so a new run can start.
		 */
		async sweep(): Promise<string[]> {
			const orphans = await prisma.run.findMany({ where: { kind: "orchestrated", status: "running" }, select: { id: true } });
			const ids = orphans.map((run) => run.id).filter((id) => !jobs.has(id));
			if (ids.length) {
				await prisma.run.updateMany({
					where: { id: { in: ids }, status: "running" },
					data: { status: "partial", partial: true, phase: "done", finishedAt: new Date(), lastEventAt: new Date(), stopReason: "orchestrator restarted mid-run", errorCode: "orchestrator_restarted" },
				});
			}
			return ids;
		},

		/** GET /healthz on a worker, server-side (the browser never talks to workers). */
		async probe(service: WorkerService, timeoutMs: number): Promise<WorkerHealth> {
			const target = settings[service];
			if (!target.token) return { configured: false, url: target.url, state: "not_configured", latencyMs: null, detail: `${service === "researcher" ? "RESEARCHER_TOKEN" : "VERIFIER_TOKEN"} is not set in backend/.env.local` };
			const client = createWorkerClient({ service, baseUrl: target.url, token: target.token, retries: { max_attempts: 1, base_ms: 1, max_backoff_ms: 1, max_retry_after_ms: 1000 }, ...settings.clientOptions });
			const result = await client.healthz({ log: probeLog, runId: null, step: 0, timeoutMs, signal: new AbortController().signal });
			if (result.up) return { configured: true, url: target.url, state: "up", latencyMs: result.latencyMs, detail: null };
			const state = result.status === "timeout" ? "asleep" : "down";
			return { configured: true, url: target.url, state, latencyMs: result.latencyMs, detail: typeof result.status === "number" ? `HTTP ${result.status}` : result.status };
		},
	};
}

export type JobRunner = ReturnType<typeof createJobRunner>;
