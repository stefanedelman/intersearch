/**
 * In-memory idempotency store for a worker (spec §7).
 *
 * One entry per request_id, keyed to the canonical hash of the request body:
 * - first time:                     "new"       → do the work, then `complete()` with the response
 * - same id, different body:        "conflict"  → 409, never retried
 * - same id + body, still running:  "in_flight" → 503 + Retry-After; the work is NOT started again
 * - same id + body, finished:       "replay"    → the stored response, byte for byte, with no new
 *                                                  model calls or fetches
 *
 * `begin()` checks and inserts in one synchronous step, so two copies arriving together cannot both
 * see "new" (Node runs this without interleaving).
 *
 * The store lives in process memory. When Render spins the verifier down (or it restarts), every
 * entry is gone: a retry that arrives afterwards is "new" and the work runs a second time.
 * ORCHESTRATION.md §3 discusses that case.
 */

export type StoredResponse = { statusCode: number; body: string };

export type BeginResult =
	| { kind: "new" }
	| { kind: "replay"; response: StoredResponse }
	| { kind: "in_flight"; retryAfterSeconds: number }
	| { kind: "conflict" };

type Entry = {
	hash: string;
	state: "running" | "done";
	deadlineAt: number;
	expiresAt: number;
	response: StoredResponse | null;
};

export type IdempotencyOptions = {
	maxEntries?: number;
	ttlMs?: number;
	now?: () => number;
	/** Bounds for the Retry-After sent to a duplicate that arrives while the first copy runs. */
	minRetryAfterSeconds?: number;
	maxRetryAfterSeconds?: number;
};

export class IdempotencyStore {
	private readonly entries = new Map<string, Entry>();
	private readonly maxEntries: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly minRetryAfter: number;
	private readonly maxRetryAfter: number;

	constructor(options: IdempotencyOptions = {}) {
		this.maxEntries = options.maxEntries ?? 1000;
		this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
		this.now = options.now ?? Date.now;
		this.minRetryAfter = options.minRetryAfterSeconds ?? 1;
		this.maxRetryAfter = options.maxRetryAfterSeconds ?? 30;
	}

	get size(): number {
		return this.entries.size;
	}

	/** `deadlineAt`: when the first copy must have answered (its time budget from receipt); used for Retry-After. */
	begin(requestId: string, hash: string, deadlineAt: number): BeginResult {
		const now = this.now();
		const existing = this.entries.get(requestId);
		if (existing && existing.state === "done" && existing.expiresAt <= now) this.entries.delete(requestId);
		const entry = this.entries.get(requestId);

		if (entry) {
			if (entry.hash !== hash) return { kind: "conflict" };
			if (entry.state === "done" && entry.response) {
				// Refresh recency so a response that is being retried is not the next one evicted.
				this.entries.delete(requestId);
				this.entries.set(requestId, entry);
				return { kind: "replay", response: entry.response };
			}
			const seconds = Math.ceil((entry.deadlineAt - now) / 1000);
			return { kind: "in_flight", retryAfterSeconds: Math.min(this.maxRetryAfter, Math.max(this.minRetryAfter, seconds)) };
		}

		this.entries.set(requestId, { hash, state: "running", deadlineAt, expiresAt: Number.POSITIVE_INFINITY, response: null });
		this.evict();
		return { kind: "new" };
	}

	/** Store the response that was sent for a "new" request. Later copies replay it. */
	complete(requestId: string, response: StoredResponse) {
		const entry = this.entries.get(requestId);
		if (!entry || entry.state === "done") return;
		entry.state = "done";
		entry.response = response;
		entry.expiresAt = this.now() + this.ttlMs;
	}

	/**
	 * Forget a "new" request that was not worked on (for example a 503 because the model's
	 * per-minute limit was hit before any work started), so a retry can run it.
	 */
	abandon(requestId: string) {
		const entry = this.entries.get(requestId);
		if (entry && entry.state === "running") this.entries.delete(requestId);
	}

	/** Drop expired entries, then the oldest finished ones while over capacity. Running entries are never evicted. */
	private evict() {
		const now = this.now();
		for (const [id, entry] of this.entries) if (entry.state === "done" && entry.expiresAt <= now) this.entries.delete(id);
		if (this.entries.size <= this.maxEntries) return;
		for (const [id, entry] of this.entries) {
			if (this.entries.size <= this.maxEntries) break;
			if (entry.state === "done") this.entries.delete(id);
		}
	}
}
