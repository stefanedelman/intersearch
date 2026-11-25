import { decodeHTML } from "entities";
import { LIMITS } from "./contract";

/**
 * The assignment's normalisation for the evidence check (spec §9), in its exact order and nothing
 * more. Both the excerpt and the fetched page text go through this same function:
 *   1. decode HTML entities (browser rules: `&amp;`, `&#x27;`, `&nbsp;`, ...)
 *   2. Unicode NFKC
 *   3. collapse every run of whitespace into one space
 *   4. lowercase
 * Any normalisation added here must also be stated in ORCHESTRATION.md.
 */
export function normalizeEvidence(text: string): string {
	return decodeHTML(text).normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
}

export type EvidenceCheck = { ok: true } | { ok: false; reason: "empty" | "too_long" | "not_found" };

/**
 * Code, not the model, decides whether a supported verdict keeps its evidence: the excerpt must be
 * at most 300 characters and, after normalising both sides, appear in the full fetched text.
 * A failed check turns the verdict into `unsupported`.
 *
 * - The 300-character cap applies to the excerpt as returned, which is what goes on the wire.
 * - One addition to the spec's steps, to state in ORCHESTRATION.md: the normalised excerpt is
 *   trimmed, so a leading or trailing space copied by the model cannot fail a match at the very
 *   start or end of the page text.
 */
export function checkEvidence(excerpt: string, fetchedText: string): EvidenceCheck {
	if (excerpt.length > LIMITS.evidenceChars) return { ok: false, reason: "too_long" };
	const needle = normalizeEvidence(excerpt).trim();
	if (needle.length === 0) return { ok: false, reason: "empty" };
	return normalizeEvidence(fetchedText).includes(needle) ? { ok: true } : { ok: false, reason: "not_found" };
}
