/**
 * Picks the parts of a page worth showing the model for a set of claims, so each verification
 * call stays small (a few thousand tokens) on a free-tier per-minute token budget. Selection is
 * plain lexical overlap, done by code. The evidence check later runs against the FULL page text,
 * so a correct excerpt is never rejected just because it fell outside these passages.
 */

const STOPWORDS = new Set(
	"the a an and or of to in on at for with by from is are was were be been this that these those it its as into per your you our we they their will can may not no than then there here which who whom what when where how about over under also".split(
		" ",
	),
);

export function contentTokens(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}$%.]+/gu) ?? [])
		.map((token) => token.replace(/^\.+|\.+$/g, ""))
		.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

/**
 * Returns the page text itself when it fits in `maxChars`; otherwise the highest-scoring sentences
 * (shared words with any claim; numbers count double), always including the opening sentence for
 * context, joined in page order with a marker between non-adjacent pieces.
 */
export function selectPassages(text: string, claims: string[], maxChars: number): string {
	if (text.length <= maxChars) return text;
	const sentences = splitSentences(text);
	const wanted = new Set(claims.flatMap(contentTokens));
	const scored = sentences.map((sentence, index) => {
		let score = 0;
		for (const token of new Set(contentTokens(sentence))) {
			if (wanted.has(token)) score += /\d/.test(token) ? 2 : 1;
		}
		return { index, sentence, score };
	});

	const chosen = new Set<number>([0]);
	let used = sentences[0]?.length ?? 0;
	for (const entry of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
		if (entry.score === 0) break;
		if (chosen.has(entry.index)) continue;
		if (used + entry.sentence.length + 1 > maxChars) continue;
		chosen.add(entry.index);
		used += entry.sentence.length + 1;
	}

	const ordered = [...chosen].sort((a, b) => a - b);
	const pieces: string[] = [];
	for (const [position, index] of ordered.entries()) {
		if (position > 0 && index !== ordered[position - 1]! + 1) pieces.push("[…]");
		pieces.push(sentences[index]!);
	}
	return pieces.join("\n");
}
