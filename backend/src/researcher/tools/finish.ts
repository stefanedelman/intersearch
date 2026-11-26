import { z } from "zod";
import { quoteAppearsIn } from "../domain/normalize";
import type { RunMemory } from "./context";

/**
 * Deliberately forgiving: finish is usually the model's last step, and an argument the schema
 * rejects ends the run without the model's selection. Unknown fields are ignored (not rejected),
 * and over-long quotes and claims are dropped later, in validateFinish. Only what code relies on is
 * required: a list of candidates, each with a source_id.
 */
export const finishArgsSchema = z.object({
	candidates: z
		.array(
			z.object({
				source_id: z.string().min(1).max(200),
				supporting_quote: z.string().max(5000).optional(),
				// Lenient on purpose: a claim that is too short, too long, or past the fourth is dropped
				// in validateFinish instead of rejecting the whole finish call (which, on the last step,
				// would end the run without the model's selection).
				claims: z.array(z.string().max(2000)).max(20).optional(),
			}),
		)
		.max(50),
});

export type FinishArgs = z.infer<typeof finishArgsSchema>;
export type AcceptedNote = { sourceDocumentId: string; identityKey: string; quote: string };
/** A factual sentence the model wrote about a posting it fetched. Code does not judge it: the verifier does. */
export type ModelClaim = { sourceDocumentId: string; identityKey: string; text: string };

/**
 * finish(report): the model names the postings it considers best, each with an optional short
 * verbatim source quote and up to four short factual claims about that posting. Finding a quote in
 * a page cannot prove a model-written claim is true, so claims are not checked here: each one is
 * sent, with the URL of the page it is about, to the independent verifier. Ranking stays code-owned.
 */
export const MAX_CLAIMS_PER_CANDIDATE = 4;

/**
 * Accepts the candidates that name a page fetched in this run and drops the rest (reported in
 * `errors`). The call is rejected only when no candidate is usable, so one bad source_id does not
 * throw away the model's whole selection. Claims outside 8–300 characters, and any past the
 * fourth per candidate, are dropped and counted.
 */
export function validateFinish(memory: RunMemory, args: FinishArgs, sourceText: (id: string) => string | null) {
	const errors: string[] = [];
	const notes: AcceptedNote[] = [];
	const claims: ModelClaim[] = [];
	let droppedNotes = 0;
	let droppedClaims = 0;
	let accepted = 0;
	for (const candidate of args.candidates.slice(0, 20)) {
		const observation = memory.observations.get(candidate.source_id);
		if (!observation) {
			errors.push(`source_id ${candidate.source_id} was not fetched in this run`);
			continue;
		}
		accepted += 1;
		const usable = (candidate.claims ?? []).map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => text.length >= 8 && text.length <= 300);
		droppedClaims += (candidate.claims ?? []).length - Math.min(usable.length, MAX_CLAIMS_PER_CANDIDATE);
		for (const text of usable.slice(0, MAX_CLAIMS_PER_CANDIDATE)) claims.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, text });
		if (candidate.supporting_quote && candidate.supporting_quote.trim().length > 300) {
			droppedNotes += 1;
		} else if (candidate.supporting_quote) {
			const text = sourceText(candidate.source_id) ?? "";
			if (quoteAppearsIn(candidate.supporting_quote, text)) {
				notes.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, quote: candidate.supporting_quote.trim() });
			} else {
				droppedNotes += 1;
			}
		}
	}
	const ok = accepted > 0 || args.candidates.length === 0;
	return { ok, errors, notes, claims, droppedNotes, droppedClaims };
}
