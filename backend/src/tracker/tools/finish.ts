import { z } from "zod";
import { quoteAppearsIn } from "../domain/normalize";
import type { RunMemory } from "./context";

export const finishArgsSchema = z.object({
	candidates: z
		.array(
			z.object({
				source_id: z.string().min(1).max(100),
				supporting_quote: z.string().max(300).optional(),
			}).strict(),
		)
		.max(20),
}).strict();

export type FinishArgs = z.infer<typeof finishArgsSchema>;
export type AcceptedNote = { sourceDocumentId: string; identityKey: string; quote: string };

/**
 * finish(report): the model names the postings it considers best, each with an optional short
 * verbatim source quote. There is no free-form reason: finding a quote in a page cannot prove
 * that an accompanying model-written claim is true. Ranking and fit explanations are code-owned.
 */
export function validateFinish(memory: RunMemory, args: FinishArgs, sourceText: (id: string) => string | null) {
	const errors: string[] = [];
	const notes: AcceptedNote[] = [];
	let droppedNotes = 0;
	for (const candidate of args.candidates) {
		const observation = memory.observations.get(candidate.source_id);
		if (!observation) {
			errors.push(`source_id ${candidate.source_id} was not fetched in this run`);
			continue;
		}
		if (candidate.supporting_quote) {
			const text = sourceText(candidate.source_id) ?? "";
			if (quoteAppearsIn(candidate.supporting_quote, text)) {
				notes.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, quote: candidate.supporting_quote.trim() });
			} else {
				droppedNotes += 1;
			}
		}
	}
	return { ok: errors.length === 0, errors, notes, droppedNotes };
}
