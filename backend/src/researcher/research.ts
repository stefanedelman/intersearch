import type { ResearchRequest, ResearchResult, WorkerErrorCode } from "../shared/contract";
import { ConfigError, loadConfig, type TrackerConfig } from "../shared/config";
import type { guardedGet } from "../shared/fetch/transport";
import type { CallModel } from "../shared/providers/groq";
import { WorkerUnavailable, type WorkContext, type WorkOutcome } from "../shared/worker/app";
import { Budget } from "./budget";
import { buildDevelopments } from "./developments";
import { runAgentLoop, type LoopOutcome } from "./loop";
import type { Search } from "./providers/tavily";
import { RunStore } from "./store";
import { emptyMemory, policyFor, transportFor, type ToolContext } from "./tools/context";
import { Trace, type TraceEvent } from "./trace";

export type ResearcherDeps = {
	configPath: string;
	callModel: CallModel;
	search: Search | null;
	/** Test injection: the guarded transport. */
	fetcher?: typeof guardedGet;
	/** Test injection: config without a file. */
	loadConfig?: (path: string) => TrackerConfig;
};

/**
 * config.yaml's `limits` are the researcher's own ceilings; the orchestrator's share can only
 * lower them. topic and k come from the request.
 */
export function applyShare(config: TrackerConfig, request: ResearchRequest, remainingMs: number): TrackerConfig {
	const { budget, payload } = request;
	return {
		...config,
		tracker: { ...config.tracker, topic: payload.topic, k: payload.k },
		limits: {
			...config.limits,
			max_steps: Math.min(config.limits.max_steps, budget.max_steps),
			max_model_calls: Math.min(config.limits.max_model_calls, budget.max_steps),
			max_total_tokens: Math.min(config.limits.max_total_tokens, budget.max_tokens),
			max_elapsed_seconds: Math.max(0, remainingMs) / 1000,
		},
	};
}

/** The loop's stop reasons, in the contract's words. */
export function errorCodeFor(outcome: LoopOutcome): WorkerErrorCode {
	switch (outcome.errorCode) {
		case "max_steps":
		case "max_model_calls":
		case "max_tool_calls":
			return "step_budget_exhausted";
		case "max_total_tokens":
			return "token_budget_exhausted";
		case "max_page_requests":
		case "max_fetches":
		case "max_network_requests":
			return "fetch_budget_exhausted";
		case "max_elapsed_seconds":
			return "time_budget_exhausted";
		case "rate_limit_minute":
		case "rate_limit_unknown":
			return "model_rate_limited";
		case "auth":
		case "permission":
			return "model_auth_failed";
		case "quota_exhausted":
		case "payment":
			return "model_quota_exhausted";
		case "no_finish":
			return "model_output_invalid";
		default:
			return "internal";
	}
}

/** Turns the researcher's internal trace events into the spec's `out` lines (calls it made). */
function traceSink(ctx: WorkContext<ResearchResult>, modelId: string) {
	return (event: TraceEvent) => {
		const detail = (event.detail ?? {}) as Record<string, unknown>;
		const httpStatus = typeof detail.httpStatus === "number" ? detail.httpStatus : null;
		if (event.category === "model") {
			ctx.trace({
				ts: new Date(event.startedAt),
				step: event.step,
				endpoint_or_tool: `groq ${modelId}`,
				status: event.status === "ok" ? 200 : (httpStatus ?? "error"),
				latency_ms: event.latencyMs,
				tokens: event.inputTokens !== null || event.outputTokens !== null ? (event.inputTokens ?? 0) + (event.outputTokens ?? 0) : null,
				error_code: event.errorCode,
			});
		} else if (event.category === "http") {
			const verb = event.tool === "search_web" ? "search" : "fetch";
			ctx.trace({
				ts: new Date(event.startedAt),
				step: event.step,
				endpoint_or_tool: `${verb} ${event.service ?? "unknown"}`,
				status: httpStatus ?? (event.status === "ok" ? 200 : "error"),
				latency_ms: event.latencyMs,
				tokens: null,
				error_code: event.errorCode,
				detail: { tool: event.tool, ...(typeof detail.redirectHop === "number" && detail.redirectHop > 0 ? { redirect_hop: detail.redirectHop } : {}) },
			});
		} else if (event.category === "tool") {
			// Tool calls are not network calls, but they are what the model did with each step; a
			// rejected finish (and why) must be visible in the evidence trace.
			const errors = Array.isArray(detail.errors) ? (detail.errors as unknown[]).slice(0, 5).map((error) => String(error).slice(0, 200)) : undefined;
			ctx.trace({
				ts: new Date(event.startedAt),
				step: event.step,
				endpoint_or_tool: `tool ${event.tool ?? "unknown"}`,
				status: event.status,
				latency_ms: event.latencyMs,
				tokens: null,
				error_code: event.errorCode,
				...(event.tool === "finish" || errors ? { detail: { ...(errors ? { errors } : {}), ...(typeof detail.claims === "number" ? { claims: detail.claims, dropped_claims: detail.droppedClaims } : {}) } } : {}),
			});
		} else if (event.category === "budget") {
			ctx.trace({
				ts: new Date(event.startedAt),
				step: event.step,
				endpoint_or_tool: "budget",
				status: event.status,
				latency_ms: typeof detail.waitMs === "number" ? detail.waitMs : null,
				tokens: null,
				error_code: event.errorCode,
			});
		}
	};
}

/**
 * POST /research: the 1B agent loop behind the contract. Stateless between requests: no saved
 * pages, no history, no baseline (the orchestrator owns all of that). The worker clock started
 * when the request arrived; the share in the envelope bounds steps, page fetches, and tokens.
 */
export function createResearchHandler(deps: ResearcherDeps) {
	return async function handle(request: ResearchRequest, ctx: WorkContext<ResearchResult>): Promise<WorkOutcome<ResearchResult>> {
		let base: TrackerConfig;
		try {
			base = (deps.loadConfig ?? loadConfig)(deps.configPath);
		} catch (error) {
			if (error instanceof ConfigError) return { status: "failed", error: { code: "internal", message: `config.yaml is invalid: ${error.message}`.slice(0, 500), retryable: false } };
			throw error;
		}
		const config = applyShare(base, request, ctx.remainingMs());
		if (request.budget.max_steps === 0) {
			return { status: "partial", result: { developments: [] }, error: { code: "step_budget_exhausted", message: "the step budget is 0, so no research was attempted", retryable: false } };
		}

		const budget = new Budget(config.limits, Date.now, request.budget.max_fetches);
		const memory = emptyMemory();
		const store = new RunStore();
		const modelClaims: Parameters<typeof buildDevelopments>[0]["modelClaims"] = [];
		const syncUsage = () => {
			const totals = budget.snapshot;
			ctx.usage.steps = totals.modelCalls;
			ctx.usage.fetches = totals.pageRequests;
			ctx.usage.tokens = totals.inputTokens + totals.outputTokens + totals.reservedTokens;
		};
		const developments = () => buildDevelopments({ memory, store, modelClaims, config, k: request.payload.k });

		const sink = traceSink(ctx, config.model.id);
		const trace = new Trace(request.run_id, null, (event) => {
			sink(event);
			syncUsage();
			// After each tool call, keep the best answer so far for the runtime's deadline backstop.
			if (event.category === "tool") ctx.setPartial({ developments: developments() });
		});
		const toolContext: ToolContext = {
			config,
			policy: policyFor(config),
			transport: transportFor(config),
			budget,
			trace,
			step: 0,
			parentEventId: null,
			store,
			search: deps.search,
			memory,
			fetcher: deps.fetcher,
		};

		const outcome = await runAgentLoop({ config, ctx: toolContext, callModel: deps.callModel, isInterrupted: () => ctx.signal.aborted, signal: ctx.signal, log: () => undefined });
		syncUsage();
		modelClaims.push(...outcome.claims);
		const result: ResearchResult = { developments: developments() };

		if (outcome.status === "complete") return { status: "complete", result };
		const code = errorCodeFor(outcome);
		const message = (outcome.stopReason ?? code).slice(0, 500);
		if (code === "model_rate_limited") {
			// Rate-limited before learning anything: "not now" (503 + Retry-After) beats an empty partial.
			// A rate limit is never a 500: retrying later can fix it.
			if (memory.observations.size === 0 && budget.snapshot.modelCalls <= 1) throw new WorkerUnavailable("model_rate_limited", message, 30);
			return { status: "partial", result, error: { code, message, retryable: false } };
		}
		if (outcome.status === "failed") return { status: "failed", error: { code, message, retryable: false } };
		return { status: "partial", result, error: { code, message, retryable: false } };
	};
}
