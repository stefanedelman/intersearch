import type { TrackerConfig } from "../shared/config";

export type BudgetLimit =
	| "max_steps"
	| "max_model_calls"
	| "max_tool_calls"
	| "max_searches"
	| "max_fetches"
	| "max_network_requests"
	| "max_total_tokens"
	| "max_search_credits"
	| "max_elapsed_seconds"
	| "max_page_requests";

export class BudgetExhausted extends Error {
	constructor(
		readonly limit: BudgetLimit,
		detail: string,
	) {
		super(`budget exhausted: ${limit} (${detail})`);
	}
}

export type BudgetTotals = {
	steps: number;
	modelCalls: number;
	toolCalls: number;
	searches: number;
	fetches: number;
	networkRequests: number;
	inputTokens: number;
	outputTokens: number;
	reservedTokens: number;
	searchCredits: number;
	retries: number;
	/** HTTP requests to web pages (job feeds and articles), each redirect hop counted. The contract's "fetches". */
	pageRequests: number;
	elapsedMs: number;
};

/**
 * Per-run budget enforced by the runtime, never by the model. Every check happens BEFORE the
 * request it guards, so exhausting a limit stops the run without making the over-budget call.
 * Retries and redirects count like any other request.
 */
export class Budget {
	private readonly startedAt: number;
	private readonly totals: Omit<BudgetTotals, "elapsedMs"> = {
		steps: 0,
		modelCalls: 0,
		toolCalls: 0,
		searches: 0,
		fetches: 0,
		networkRequests: 0,
		inputTokens: 0,
		outputTokens: 0,
		reservedTokens: 0,
		searchCredits: 0,
		retries: 0,
		pageRequests: 0,
	};

	constructor(
		private readonly limits: TrackerConfig["limits"],
		private readonly now: () => number = Date.now,
		/** The worker's fetch share (spec: one fetch = one HTTP request to a web page, redirects included). Unlimited if omitted. */
		private readonly maxPageRequests: number = Number.POSITIVE_INFINITY,
	) {
		this.startedAt = now();
	}

	get snapshot(): BudgetTotals {
		return { ...this.totals, elapsedMs: this.now() - this.startedAt };
	}

	remainingMs(): number {
		return this.limits.max_elapsed_seconds * 1000 - (this.now() - this.startedAt);
	}

	private ensure(condition: boolean, limit: BudgetLimit, detail: string) {
		if (!condition) throw new BudgetExhausted(limit, detail);
	}

	checkDeadline() {
		this.ensure(this.remainingMs() > 0, "max_elapsed_seconds", `${this.limits.max_elapsed_seconds}s elapsed`);
	}

	beginStep() {
		this.checkDeadline();
		this.ensure(this.totals.steps < this.limits.max_steps, "max_steps", `${this.totals.steps}/${this.limits.max_steps}`);
		this.totals.steps += 1;
	}

	beginToolCall() {
		this.checkDeadline();
		this.ensure(this.totals.toolCalls < this.limits.max_tool_calls, "max_tool_calls", `${this.totals.toolCalls}/${this.limits.max_tool_calls}`);
		this.totals.toolCalls += 1;
	}

	/** Reserve before a model request: a conservative input estimate plus the full output ceiling. */
	reserveModelCall(estimatedInputTokens: number, maxOutputTokens: number): number {
		this.checkDeadline();
		this.ensure(this.totals.modelCalls < this.limits.max_model_calls, "max_model_calls", `${this.totals.modelCalls}/${this.limits.max_model_calls}`);
		const reservation = estimatedInputTokens + maxOutputTokens;
		const used = this.totals.inputTokens + this.totals.outputTokens + this.totals.reservedTokens;
		this.ensure(used + reservation <= this.limits.max_total_tokens, "max_total_tokens", `${used} used + ${reservation} needed > ${this.limits.max_total_tokens}`);
		this.reserveNetwork();
		this.totals.modelCalls += 1;
		this.totals.reservedTokens += reservation;
		return reservation;
	}

	/** Replace the reservation with actual usage. If the provider reported none, keep the reservation. */
	settleModelCall(reservation: number, usage: { input: number; output: number } | null) {
		this.totals.reservedTokens -= reservation;
		if (usage) {
			this.totals.inputTokens += usage.input;
			this.totals.outputTokens += usage.output;
		} else {
			this.totals.inputTokens += reservation;
		}
	}

	reserveSearch(credits: number) {
		this.checkDeadline();
		this.ensure(this.totals.searches < this.limits.max_searches, "max_searches", `${this.totals.searches}/${this.limits.max_searches}`);
		this.ensure(this.totals.searchCredits + credits <= this.limits.max_search_credits, "max_search_credits", `${this.totals.searchCredits}+${credits}/${this.limits.max_search_credits}`);
		this.reserveNetwork();
		this.totals.searches += 1;
		this.totals.searchCredits += credits;
	}

	reserveFetch() {
		this.checkDeadline();
		this.ensure(this.totals.fetches < this.limits.max_fetches, "max_fetches", `${this.totals.fetches}/${this.limits.max_fetches}`);
		this.totals.fetches += 1;
	}

	/** Before every request to a web page, including each redirect hop. */
	reservePageRequest() {
		this.checkDeadline();
		this.ensure(this.totals.pageRequests < this.maxPageRequests, "max_page_requests", `${this.totals.pageRequests}/${this.maxPageRequests}`);
		this.totals.pageRequests += 1;
	}

	get pageRequestsLeft(): number {
		return this.maxPageRequests - this.totals.pageRequests;
	}

	reserveNetwork(count = 1) {
		this.checkDeadline();
		this.ensure(this.totals.networkRequests + count <= this.limits.max_network_requests, "max_network_requests", `${this.totals.networkRequests}/${this.limits.max_network_requests}`);
		this.totals.networkRequests += count;
	}

	recordRetry() {
		this.totals.retries += 1;
	}
}
