import type { Budget, Usage, WorkerService } from "../shared/contract";
import type { OrchestrationConfig } from "../shared/config";

/**
 * One budget per run (spec §8), owned by the orchestrator.
 *
 * - The total comes from config.yaml (`orchestration.total_budget`).
 * - Each request_id is reserved before it is sent and charged exactly once when it ends: a retry,
 *   or a stored response replayed by the worker, never charges again.
 * - Charge = the usage the worker reported (clamped at 0). A worker that reports more than its
 *   share is still charged what it reported, and the overrun is recorded.
 * - A request that got no usable answer (every attempt failed, timed out, or the run was
 *   cancelled) is charged its full share: the worker may have spent it.
 * - Shares are computed only from config and ledger numbers, never from worker text.
 */

export type Dimensions = { steps: number; fetches: number; tokens: number };

export type ChargeBasis = "reported" | "full_share" | "none";

export type LedgerEntry = {
	requestId: string;
	service: WorkerService;
	share: Dimensions;
	charged: Dimensions | null;
	basis: ChargeBasis | null;
	overrun: boolean;
};

const DIMS = ["steps", "fetches", "tokens"] as const;
const zero = (): Dimensions => ({ steps: 0, fetches: 0, tokens: 0 });

export const fromBudget = (budget: Budget): Dimensions => ({ steps: budget.max_steps, fetches: budget.max_fetches, tokens: budget.max_tokens });
export const toBudget = (share: Dimensions): Budget => ({ max_steps: share.steps, max_fetches: share.fetches, max_tokens: share.tokens });

export class LedgerError extends Error {}

export class Ledger {
	private readonly entries = new Map<string, LedgerEntry>();

	constructor(readonly total: Dimensions) {}

	static fromConfig(config: OrchestrationConfig) {
		return new Ledger(fromBudget(config.total_budget));
	}

	/** Sum of charges so far. */
	get charged(): Dimensions {
		const sum = zero();
		for (const entry of this.entries.values()) if (entry.charged) for (const dim of DIMS) sum[dim] += entry.charged[dim];
		return sum;
	}

	/** Shares reserved by requests that have not been charged yet (at most one: calls are sequential). */
	get outstanding(): Dimensions {
		const sum = zero();
		for (const entry of this.entries.values()) if (!entry.charged) for (const dim of DIMS) sum[dim] += entry.share[dim];
		return sum;
	}

	/** What a new request could still be given: total − charged − outstanding, never below 0. */
	get remaining(): Dimensions {
		const charged = this.charged;
		const outstanding = this.outstanding;
		const left = zero();
		for (const dim of DIMS) left[dim] = Math.max(0, this.total[dim] - charged[dim] - outstanding[dim]);
		return left;
	}

	canCover(share: Dimensions): boolean {
		const left = this.remaining;
		return DIMS.every((dim) => share[dim] <= left[dim]);
	}

	/** Records the share before the request is sent. Throws if it does not fit or the id was used. */
	reserve(requestId: string, service: WorkerService, share: Dimensions): LedgerEntry {
		if (this.entries.has(requestId)) throw new LedgerError(`request_id ${requestId} is already in the ledger`);
		if (!this.canCover(share)) throw new LedgerError(`share ${JSON.stringify(share)} exceeds what is left (${JSON.stringify(this.remaining)})`);
		const entry: LedgerEntry = { requestId, service, share: { ...share }, charged: null, basis: null, overrun: false };
		this.entries.set(requestId, entry);
		return entry;
	}

	/**
	 * Charges a request once. `usage` is what the worker reported (null when there is no usable
	 * report: then the full share is charged). Charging an id again returns the first charge
	 * unchanged.
	 */
	charge(requestId: string, usage: Pick<Usage, "steps" | "fetches" | "tokens"> | null, basis?: ChargeBasis): LedgerEntry {
		const entry = this.entries.get(requestId);
		if (!entry) throw new LedgerError(`request_id ${requestId} was never reserved`);
		if (entry.charged) return entry;
		if (basis === "none") {
			entry.charged = zero();
			entry.basis = "none";
			return entry;
		}
		if (!usage) {
			entry.charged = { ...entry.share };
			entry.basis = "full_share";
			return entry;
		}
		const charged = zero();
		for (const dim of DIMS) charged[dim] = Math.max(0, Math.floor(Number.isFinite(usage[dim]) ? usage[dim] : 0));
		entry.charged = charged;
		entry.basis = "reported";
		entry.overrun = DIMS.some((dim) => charged[dim] > entry.share[dim]);
		return entry;
	}

	get(requestId: string): LedgerEntry | undefined {
		return this.entries.get(requestId);
	}

	/** Stored on Run.ledger and shown in the UI. */
	snapshot() {
		return {
			total: { ...this.total },
			charged: this.charged,
			remaining: this.remaining,
			entries: [...this.entries.values()].map((entry) => ({ ...entry, share: { ...entry.share }, charged: entry.charged ? { ...entry.charged } : null })),
		};
	}
}

export type LedgerSnapshot = ReturnType<Ledger["snapshot"]>;

/** The researcher's share: `split.researcher` of every dimension of the total. */
export function researcherShare(config: OrchestrationConfig): Dimensions {
	const total = fromBudget(config.total_budget);
	const split = config.split.researcher;
	return { steps: Math.floor(total.steps * split), fetches: Math.floor(total.fetches * split), tokens: Math.floor(total.tokens * split) };
}

/**
 * The next verify chunk's share: what is left divided evenly over the chunks still to send, but at
 * least `min_verify_share` (so the higher-ranked chunk is not starved when the remainder is thin).
 * Null when even the minimum does not fit: the chunk is not sent.
 */
export function verifierShare(remaining: Dimensions, chunksLeft: number, minimum: OrchestrationConfig["min_verify_share"]): Dimensions | null {
	const share = zero();
	for (const dim of DIMS) {
		if (remaining[dim] < minimum[dim]) return null;
		share[dim] = Math.min(remaining[dim], Math.max(minimum[dim], Math.floor(remaining[dim] / Math.max(1, chunksLeft))));
	}
	return share;
}
