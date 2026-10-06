import { randomUUID } from "node:crypto";
import { ApiRequestError, ApiUnavailable, type TrackerApi } from "./api-client";
import type { TrackerStateDto } from "../contracts/tracker";
import { Budget } from "./budget";
import { configHash, type TrackerConfig } from "./config";
import { buildFinalizeBody } from "./finalize";
import type { guardedGet } from "./fetch/transport";
import { artifacts, runDir } from "./local-artifacts";
import { runAgentLoop, type LoopOutcome } from "./loop";
import type { CallModel } from "./providers/groq";
import type { Search } from "./providers/tavily";
import { RunStore } from "./store";
import { emptyMemory, policyFor, transportFor, type ToolContext } from "./tools/context";
import { Trace } from "./trace";

export type ExecuteRunOptions = {
	config: TrackerConfig;
	api: TrackerApi;
	callModel: CallModel;
	search: Search | null;
	log: (message: string) => void;
	isInterrupted?: () => boolean;
	fetcher?: typeof guardedGet;
	/** Lets the CLI attach API round trips to this run's trace once it exists. */
	onTrace?: (trace: Trace) => void;
};

/**
 * One complete tracker run: import config, start the run, load saved state, run the agent loop,
 * build the report, write it locally, then upload. Upload failures leave everything on disk for
 * `tracker:sync`; they never lose the report.
 */
export async function executeRun(options: ExecuteRunOptions) {
	const { config, api, log } = options;
	const hash = configHash(config);

	await api.importConfig(config);
	const started = await api.startRun(randomUUID());
	const runId = started.runId;
	const trace = new Trace(runId, runDir(runId));
	options.onTrace?.(trace);
	log(`Run ${runId} started${started.baselineRunId ? `, comparing with run ${started.baselineRunId}` : " (no earlier complete run to compare with)"}.`);
	if (started.abandonedRunIds.length) log(`Closed ${started.abandonedRunIds.length} abandoned run(s) as partial.`);

	const budget = new Budget(config.limits);
	let state: TrackerStateDto | null = null;
	let store = new RunStore(api, runId, trace, null);
	const memory = emptyMemory();

	const ctx: ToolContext = {
		config,
		policy: policyFor(config),
		transport: transportFor(config),
		budget,
		trace,
		step: 0,
		parentEventId: null,
		store,
		search: options.search,
		memory,
		fetcher: options.fetcher,
	};
	trace.record({
		category: "run",
		status: "started",
		arguments: { configHash: hash, model: config.model.id, k: config.tracker.k },
		detail: { baselineRunId: started.baselineRunId },
	});

	let outcome: LoopOutcome;
	try {
		state = await api.state(runId);
		store = new RunStore(api, runId, trace, state);
		ctx.store = store;
		for (const opportunity of state.opportunities) if (opportunity.firstReportedAt) memory.everReported.add(opportunity.identityKey);
		outcome = await runAgentLoop({ config, state, ctx, callModel: options.callModel, isInterrupted: options.isInterrupted ?? (() => false), log });
	} catch (error) {
		outcome = error instanceof ApiUnavailable
			? { status: "partial", stopReason: error.message.slice(0, 400), errorCode: "api_unavailable", notes: [] }
			: { status: "failed", stopReason: `unexpected error: ${(error as Error).message}`.slice(0, 400), errorCode: "internal", notes: [] };
	}
	trace.record({ category: "run", status: outcome.status, errorCode: outcome.errorCode, detail: { stopReason: outcome.stopReason, totals: budget.snapshot } });

	const extraNotes: string[] = [];
	if (!state) extraNotes.push("Previous state could not be loaded. No research was attempted and no comparison with earlier results is available.");
	if (!store.apiReachable) extraNotes.push("The Intersearch API was unreachable during part of this run; results were saved locally first.");
	const body = buildFinalizeBody({ runId, config, configHash: hash, outcome, memory, state, store, notes: outcome.notes, budget, extraNotes });

	// Local copy first: the report and trace exist even if the upload below fails.
	artifacts.saveFinalize(runId, body);
	let uploaded = await store.flush();
	let uploadError: string | null = uploaded ? null : store.lastApiError;
	if (uploaded) {
		try {
			await options.api.finalize(runId, body);
		} catch (error) {
			uploaded = false;
			uploadError = error instanceof ApiRequestError ? `${error.message} ${JSON.stringify(error.details ?? "")}` : (error as Error).message;
		}
	}

	return { runId, outcome, body, budget: budget.snapshot, uploaded, uploadError, tracePath: trace.path, reportPath: artifacts.reportMarkdownFile(runId) };
}
