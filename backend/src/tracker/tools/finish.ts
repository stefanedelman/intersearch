import { z } from "zod";
import { quoteAppearsIn } from "../domain/normalize";
import type { RunMemory } from "./context";

export const finishArgsSchema = z.object({
	candidates: z
		.array(
			z.object({
				source_id: z.string().min(1).max(100),
				reason: z.string().max(300).optional(),
				supporting_quote: z.string().max(300).optional(),
			}),
		)
		.max(20),
});

export type FinishArgs = z.infer<typeof finishArgsSchema>;
export type AcceptedNote = { sourceDocumentId: string; identityKey: string; reason: string; quote: string };

/**
 * finish(report): the model names the postings it considers best, each with an optional short
 * reason backed by a verbatim quote. Code validates everything: unknown source ids are rejected,
 * and a note whose quote is not in the source is dropped. Ranking itself is done by code.
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
		if (candidate.reason && candidate.supporting_quote) {
			const text = sourceText(candidate.source_id) ?? "";
			if (quoteAppearsIn(candidate.supporting_quote, text)) {
				notes.push({ sourceDocumentId: candidate.source_id, identityKey: observation.identity.key, reason: candidate.reason.trim(), quote: candidate.supporting_quote.trim() });
			} else {
				droppedNotes += 1;
			}
		}
	}
	return { ok: errors.length === 0, errors, notes, droppedNotes };
}
