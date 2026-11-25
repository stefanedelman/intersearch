import type { Extracted } from "../shared/fetch/extract";

export type StoredDocument = {
	id: string;
	canonicalUrl: string;
	finalUrl: string | null;
	title: string | null;
	fetchedAt: string;
	contentHash: string;
	sourceKind: Extracted["sourceKind"] | null;
	metadata: Record<string, unknown> | null;
	text: string | null;
	httpStatus: number;
	fetchedThisRun: boolean;
};

export type DocumentInput = Omit<StoredDocument, "fetchedThisRun">;

export type FetchAttemptRecord = {
	eventId: string;
	requestedUrl: string;
	canonicalUrl: string | null;
	sourceDocumentId: string | null;
	status: "fetched" | "skipped_seen" | "rejected" | "failed";
	reason: string | null;
	title: string | null;
	attemptedAt: string;
	latencyMs: number | null;
	bytes: number | null;
	retryCount: number;
};

/**
 * Pages fetched during ONE research request, in memory. The researcher keeps no state between
 * requests: run history and the last top K belong to the orchestrator. Within a request, a URL
 * fetched twice is served from here (status skipped_seen, no second request).
 */
export class RunStore {
	private readonly byCanonical = new Map<string, StoredDocument>();
	private readonly byId = new Map<string, StoredDocument>();
	readonly attempts: FetchAttemptRecord[] = [];

	findCached(canonicalUrl: string): StoredDocument | undefined {
		return this.byCanonical.get(canonicalUrl);
	}

	getById(id: string): StoredDocument | undefined {
		return this.byId.get(id);
	}

	resolveId(id: string): string {
		return id;
	}

	async loadText(doc: StoredDocument): Promise<StoredDocument> {
		return doc;
	}

	addDocument(input: DocumentInput): StoredDocument {
		const doc: StoredDocument = { ...input, fetchedThisRun: true };
		this.byCanonical.set(doc.canonicalUrl, doc);
		this.byId.set(doc.id, doc);
		return doc;
	}

	recordAttempt(attempt: FetchAttemptRecord) {
		this.attempts.push(attempt);
	}
}
