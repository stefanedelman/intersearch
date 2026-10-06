import type { CheckpointBody, FinalizeBody, StartRunResponse, TrackerStateDto } from "../contracts/tracker";
import type { ReportJson } from "../contracts/report";
import type { TrackerConfig } from "./config";

export class ApiUnavailable extends Error {}

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

export type ApiRoundTrip = { method: string; path: string; status: number | "network_error"; startedAt: Date; latencyMs: number; attempt: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The tracker's only path to persistence: authenticated HTTP to our Express API. It never
 * touches the database. Transient failures (network errors, 5xx) get bounded retries; an
 * expired token triggers one re-login with the local credentials.
 */
export class TrackerApi {
	private token: string | null = null;
	private credentials: { username: string; password: string } | null = null;

	constructor(
		private readonly baseUrl: string,
		private readonly onRoundTrip?: (trip: ApiRoundTrip) => void,
		private readonly maxRetries = 2,
	) {}

	async login(username: string, password: string) {
		this.credentials = { username, password };
		const result = await this.request<{ token: string; user: { id: string; username: string } }>("POST", "/api/auth/login", { username, password }, { auth: false });
		this.token = result.token;
		return result.user;
	}

	private async request<T>(method: string, path: string, body?: unknown, options: { auth?: boolean; retried401?: boolean } = {}): Promise<T> {
		const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
		for (let attempt = 0; ; attempt += 1) {
			const started = Date.now();
			let response: Response;
			let text: string;
			try {
				response = await fetch(url, {
					method,
					headers: {
						accept: "application/json",
						...(body !== undefined ? { "content-type": "application/json" } : {}),
						...(options.auth !== false && this.token ? { authorization: `Bearer ${this.token}` } : {}),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(30_000),
				});
				text = await response.text();
			} catch (error) {
				this.onRoundTrip?.({ method, path, status: "network_error", startedAt: new Date(started), latencyMs: Date.now() - started, attempt });
				if (attempt < this.maxRetries) {
					await sleep(1000 * 2 ** attempt);
					continue;
				}
				throw new ApiUnavailable(`Cannot reach the Intersearch API at ${this.baseUrl} (${(error as Error).message}). Is the backend running? Start it with: npm run dev:backend`);
			}
			this.onRoundTrip?.({ method, path, status: response.status, startedAt: new Date(started), latencyMs: Date.now() - started, attempt });
			const payload = text ? safeJson(text) : null;
			if (response.ok) return payload as T;

			if (response.status === 401 && options.auth !== false && this.credentials && !options.retried401) {
				await this.login(this.credentials.username, this.credentials.password);
				return this.request<T>(method, path, body, { ...options, retried401: true });
			}
			if ((response.status >= 500 || response.status === 429) && attempt < this.maxRetries) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
			if (response.status === 503) throw new ApiUnavailable(error?.message ?? "The Intersearch API is temporarily unavailable.");
			throw new ApiRequestError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? `HTTP ${response.status}`, error?.details);
		}
	}

	importConfig(config: TrackerConfig) {
		return this.request<{ configHash: string; comparisonKey: string }>("PUT", "/api/tracker/config", { config });
	}

	startRun(idempotencyKey: string) {
		return this.request<StartRunResponse>("POST", "/api/tracker/runs", { idempotencyKey });
	}

	state(runId?: string) {
		return this.request<TrackerStateDto>("GET", `/api/tracker/state${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
	}

	document(id: string) {
		return this.request<{ id: string; text: string; title: string | null; finalUrl: string; canonicalUrl: string; sourceKind: string; fetchedAt: string; contentHash: string; metadata: Record<string, unknown> | null }>(
			"GET",
			`/api/tracker/documents/${encodeURIComponent(id)}`,
		);
	}

	checkpoint(runId: string, body: CheckpointBody) {
		return this.request<{ documentIds: Record<string, string> }>("POST", `/api/tracker/runs/${runId}/checkpoint`, body);
	}

	finalize(runId: string, body: FinalizeBody) {
		return this.request<{ reportId: string; alreadyFinalized: boolean }>("POST", `/api/tracker/runs/${runId}/finalize`, body);
	}

	report(runId: string) {
		return this.request<{ report: ReportJson; markdown: string; status: string; createdAt: string }>("GET", `/api/tracker/runs/${runId}/report`);
	}

	run(runId: string) {
		return this.request<{ run: { id: string; status: string; startedAt: string; finishedAt: string | null; configHash: string } }>("GET", `/api/tracker/runs/${runId}`);
	}

	trace(runId: string, cursor?: string) {
		return this.request<{ events: Record<string, unknown>[]; nextCursor: string | null }>("GET", `/api/tracker/runs/${runId}/trace?limit=500${cursor ? `&cursor=${cursor}` : ""}`);
	}

	reset(confirm: string) {
		return this.request<{ deleted: Record<string, number> }>("POST", "/api/tracker/reset", { confirm });
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
