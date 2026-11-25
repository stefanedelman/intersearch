import { z } from "zod";
import { quoteAppearsIn } from "../domain/normalize";
import type { RunMemory } from "./context";

export const finishArgsSchema = z.object({
	candidates: z
		.array(
			z.object({
				source_id: z.string().min(1).max(100),
				supporting_quote: z.string().max(300).optional(),
				claims: z.array(z.string().trim().min(8).max(300)).max(4).optional(),
			}).strict(),
		)
		.max(20),
}).strict();

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
export function validateFinish(memory: RunMemory, args: FinishArgs, sourceText: (id: string) => string | null) {
	const errors: string[] = [];
	const notes: AcceptedNote[] = [];
	const claims: ModelClaim[] = [];
	let droppedNotes = 0;
	for (const candidate of args.candidates) {
		const observation = memory.observations.get(candidate.source_id);
		if (!observation) {
			errors.push(`source_id ${candidate.source_id} was not fetched in this run`);
			continue;
		}
		for (const text of candidate.claims ?? []) claims.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, text: text.trim() });
		if (candidate.supporting_quote) {
			const text = sourceText(candidate.source_id) ?? "";
			if (quoteAppearsIn(candidate.supporting_quote, text)) {
				notes.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, quote: candidate.supporting_quote.trim() });
			} else {
				droppedNotes += 1;
			}
		}
	}
	return { ok: errors.length === 0, errors, notes, claims, droppedNotes };
}
