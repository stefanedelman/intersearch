import type { DocumentInput, FetchAttemptInput, TrackerStateDto } from "../contracts/tracker";
import { ApiUnavailable, type TrackerApi } from "./api-client";
import { artifacts, type PendingUploads } from "./local-artifacts";
import type { Trace } from "./trace";

export type StoredDocument = {
	id: string;
	canonicalUrl: string;
	finalUrl: string | null;
	title: string | null;
	fetchedAt: string;
	contentHash: string;
	sourceKind: DocumentInput["sourceKind"] | null;
	metadata: Record<string, unknown> | null;
	text: string | null;
	fetchedThisRun: boolean;
};

const CHUNK = { documents: 20, fetchAttempts: 150, events: 400 };

/**
 * Run-scoped persistence buffer. Documents, fetch attempts, and trace events are queued,
 * uploaded through the API after every tool call, and mirrored to runs/<runId>/pending.json
 * until the API acknowledges them. If the API is unreachable the run continues locally.
 */
export class RunStore {
	private readonly byCanonical = new Map<string, StoredDocument>();
	private readonly byId = new Map<string, StoredDocument>();
	private readonly alias = new Map<string, string>();
	private pending: PendingUploads = { documents: [], fetchAttempts: [], events: [] };
	apiReachable = true;
	lastApiError: string | null = null;

	constructor(
		private readonly api: TrackerApi,
		private readonly runId: string,
		private readonly trace: Trace,
		state: TrackerStateDto | null,
	) {
		for (const doc of state?.documents ?? []) {
			this.remember({ ...doc, finalUrl: null, sourceKind: null, metadata: null, text: null, fetchedThisRun: false });
		}
	}

	private remember(doc: StoredDocument) {
		this.byCanonical.set(doc.canonicalUrl, doc);
		this.byId.set(doc.id, doc);
	}

	/** A document already saved for this tracker (any run) at this canonical URL. */
	findCached(canonicalUrl: string): StoredDocument | undefined {
		return this.byCanonical.get(canonicalUrl);
	}

	getById(id: string): StoredDocument | undefined {
		return this.byId.get(this.resolveId(id)) ?? this.byId.get(id);
	}

	resolveId(id: string): string {
		return this.alias.get(id) ?? id;
	}

	/** Loads cached text from the API (a local round trip to our backend, not the source site). */
	async loadText(doc: StoredDocument): Promise<StoredDocument> {
		if (doc.text !== null) return doc;
		const full = await this.api.document(doc.id);
		Object.assign(doc, { text: full.text, title: full.title, finalUrl: full.finalUrl, sourceKind: full.sourceKind, metadata: full.metadata });
		return doc;
	}

	addDocument(input: DocumentInput): StoredDocument {
		const doc: StoredDocument = { ...input, fetchedThisRun: true };
		this.remember(doc);
		this.pending.documents.push(input);
		return doc;
	}

	recordAttempt(attempt: FetchAttemptInput) {
		this.pending.fetchAttempts.push(attempt);
	}

	/** Uploads everything queued. Never throws for connectivity problems; returns whether it succeeded. */
	async flush(): Promise<boolean> {
		this.pending.events.push(...this.trace.takePending());
		const hasWork = this.pending.documents.length || this.pending.fetchAttempts.length || this.pending.events.length;
		if (!hasWork) return true;
		try {
			while (this.pending.documents.length || this.pending.fetchAttempts.length || this.pending.events.length) {
				const documents = this.pending.documents.slice(0, CHUNK.documents);
				// Attempts may reference documents; send them only once their documents are uploaded.
				const sendingDocIds = new Set(documents.map((doc) => doc.id));
				const laterDocIds = new Set(this.pending.documents.slice(CHUNK.documents).map((doc) => doc.id));
				const fetchAttempts = this.pending.fetchAttempts
					.filter((attempt) => !attempt.sourceDocumentId || !laterDocIds.has(attempt.sourceDocumentId) || sendingDocIds.has(attempt.sourceDocumentId))
					.slice(0, CHUNK.fetchAttempts)
					.map((attempt) => ({ ...attempt, sourceDocumentId: attempt.sourceDocumentId ? this.resolveId(attempt.sourceDocumentId) : null }));
				const events = this.pending.events.slice(0, CHUNK.events);

				const result = await this.api.checkpoint(this.runId, { documents, fetchAttempts, events });
				for (const [clientId, serverId] of Object.entries(result.documentIds)) {
					if (clientId !== serverId) {
						this.alias.set(clientId, serverId);
						const doc = this.byId.get(clientId);
						if (doc) this.byId.set(serverId, { ...doc, id: serverId });
					}
				}
				const sentAttempts = new Set(fetchAttempts.map((attempt) => attempt.eventId));
				this.pending.documents = this.pending.documents.slice(documents.length);
				this.pending.fetchAttempts = this.pending.fetchAttempts.filter((attempt) => !sentAttempts.has(attempt.eventId));
				this.pending.events = this.pending.events.slice(events.length);
			}
			this.apiReachable = true;
			this.lastApiError = null;
			artifacts.savePending(this.runId, this.pending);
			return true;
		} catch (error) {
			this.apiReachable = !(error instanceof ApiUnavailable);
			this.lastApiError = (error as Error).message;
			artifacts.savePending(this.runId, this.pending);
			return false;
		}
	}

	get hasPending() {
		return this.pending.documents.length + this.pending.fetchAttempts.length + this.pending.events.length > 0;
	}
}
