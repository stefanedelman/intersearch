import { isHttpUrl, LIMITS, type Development } from "../shared/contract";
import type { TrackerConfig } from "../shared/config";
import type { Facts, Observation } from "./domain/facts";
import { compareRanked, scoreFacts } from "./domain/rank";
import type { RunStore } from "./store";
import type { RunMemory } from "./tools/context";
import type { ModelClaim } from "./tools/finish";

export type SourceRef = { sourceDocumentId: string; url: string; title: string | null; fetchedAt: string };
export type Candidate = { observation: Observation; sources: SourceRef[] };

/**
 * Several sources can describe one development (the job-board record and the careers page).
 * The structured job-board record is the base; missing facts are filled from the other sources,
 * and every source's quotes are kept, each still pointing at the document it came from.
 */
export function mergeObservations(observations: Observation[]): Observation {
	const ordered = [...observations].sort(
		(a, b) => Number(Boolean(b.facts.postedAt)) - Number(Boolean(a.facts.postedAt)) || Number(b.identity.method === "provider_id") - Number(a.identity.method === "provider_id") || b.evidence.length - a.evidence.length,
	);
	return fillMissing(ordered[0]!, ordered.slice(1));
}

/** Keeps `base` and fills only the facts it lacks from `others`, carrying over their quotes. */
export function fillMissing(base: Observation, others: Observation[]): Observation {
	const facts: Facts = { ...base.facts, locations: [...base.facts.locations], skills: [...base.facts.skills], eligibility: [...base.facts.eligibility], highlights: [...base.facts.highlights] };
	const evidence = [...base.evidence];
	const seen = new Set(evidence.map((item) => `${item.field}|${item.quote}`));
	for (const other of others) {
		const o = other.facts;
		const fill = <K extends keyof Facts>(key: K, empty: (value: Facts[K]) => boolean, fields: string[]) => {
			if (empty(facts[key]) && !empty(o[key])) {
				facts[key] = o[key];
				for (const item of other.evidence) if (fields.some((field) => item.field === field || item.field.startsWith(field)) && !seen.has(`${item.field}|${item.quote}`)) {
					evidence.push(item);
					seen.add(`${item.field}|${item.quote}`);
				}
			}
		};
		fill("locations", (value) => (value as string[]).length === 0, ["location"]);
		fill("season", (value) => !value || !String(value).includes("-"), ["season"]);
		fill("compensation", (value) => !value, ["compensation"]);
		fill("eligibility", (value) => (value as string[]).length === 0, ["eligibility"]);
		fill("highlights", (value) => (value as string[]).length === 0, ["highlight"]);
		facts.remote ||= o.remote;
		for (const skill of o.skills) {
			if (!facts.skills.includes(skill)) {
				facts.skills.push(skill);
				const quote = other.evidence.find((item) => item.field === `skill:${skill}`);
				if (quote && !seen.has(`${quote.field}|${quote.quote}`)) {
					evidence.push(quote);
					seen.add(`${quote.field}|${quote.quote}`);
				}
			}
		}
	}
	return { ...base, facts, evidence };
}

/** Every posting observed in this request, merged by development identity. */
export function assembleCandidates(memory: RunMemory): Candidate[] {
	const groups = new Map<string, { observations: Observation[]; sources: SourceRef[] }>();
	for (const [docId, observation] of memory.observations) {
		const key = observation.identity.key;
		const group = groups.get(key) ?? { observations: [], sources: [] };
		group.observations.push(observation);
		group.sources.push({ sourceDocumentId: docId, url: observation.source.url, title: observation.source.title, fetchedAt: observation.source.fetchedAt });
		groups.set(key, group);
	}
	return [...groups.values()].map((group) => ({ observation: mergeObservations(group.observations), sources: group.sources }));
}

function listPhrase(values: string[]): string {
	if (values.length <= 1) return values[0] ?? "";
	return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Factual summary assembled only from extracted, quoted facts. */
export function summarize(facts: Facts): string {
	const parts = [`${facts.company ?? "This company"} lists "${facts.title}"`];
	if (facts.locations.length) parts[0] += ` in ${listPhrase(facts.locations.slice(0, 4))}`;
	parts[0] += ".";
	if (facts.season) parts.push(`Season stated: ${facts.season.replace("-", " ")}.`);
	if (facts.skills.length) parts.push(`The posting mentions ${listPhrase(facts.skills.slice(0, 6))}.`);
	if (facts.compensation) parts.push(`Pay stated in the posting: "${facts.compensation.slice(0, 160)}".`);
	return clip(parts.join(" "), LIMITS.summaryChars);
}

const seasonPhrase = (season: string) => season.replace(/^(\w)(\w*)-(\d{4})$/, (_, first: string, rest: string, year: string) => `${first.toUpperCase()}${rest} ${year}`);

/**
 * Claims written by code from facts that have a quote, each citing the page that quote came from.
 * They are simple, checkable sentences; the verifier still checks every one independently.
 */
export function factClaims(observation: Observation): { text: string; url: string }[] {
	const { facts, evidence } = observation;
	const sourceOf = (field: string) => evidence.find((item) => item.field === field)?.url ?? null;
	const claims: { text: string; url: string | null }[] = [];
	claims.push({ text: `${facts.company ? `${facts.company} has an open posting titled` : "There is an open posting titled"} "${facts.title}".`, url: sourceOf("title") });
	if (facts.season && /-\d{4}$/.test(facts.season)) claims.push({ text: `The position is for ${seasonPhrase(facts.season)}.`, url: sourceOf("season") });
	if (facts.locations.length) claims.push({ text: `The posting lists ${listPhrase(facts.locations.slice(0, 3))} as ${facts.locations.length > 1 ? "locations" : "the location"}.`, url: sourceOf("location") });
	if (facts.remote) claims.push({ text: "The posting says the role can be done remotely.", url: sourceOf("remote") });
	if (facts.compensation) claims.push({ text: `The posting states pay of ${clip(facts.compensation, 160)}.`, url: sourceOf("compensation") });
	return claims.filter((claim): claim is { text: string; url: string } => claim.url !== null && isHttpUrl(claim.url));
}

/**
 * Ranks what this request found (code-owned ranking, exactly as in 1B) and turns the top k into
 * contract developments: code-written fact claims first, then the model's own claims about that
 * posting. Every claim cites the one page it is about.
 */
export function buildDevelopments(input: { memory: RunMemory; store: RunStore; modelClaims: ModelClaim[]; config: TrackerConfig; k: number; now?: Date }): Development[] {
	const now = input.now ?? new Date();
	const ranked = assembleCandidates(input.memory)
		.map((candidate) => {
			const scored = scoreFacts(candidate.observation.facts, input.config, { firstSeenAt: null, now });
			return { candidate, scored, identityKey: candidate.observation.identity.key, score: scored.score, company: candidate.observation.facts.company, title: candidate.observation.facts.title };
		})
		.filter((entry) => !entry.scored.excluded && entry.score > 0)
		.sort(compareRanked)
		.slice(0, input.k);

	return ranked.map((entry, index) => {
		const { observation } = entry.candidate;
		const facts = observation.facts;
		const seen = new Set<string>();
		const claims: Development["claims"] = [];
		const add = (text: string, url: string) => {
			const clean = clip(text.replace(/\s+/g, " ").trim(), LIMITS.claimTextChars);
			const key = clean.toLowerCase();
			if (!clean || seen.has(key) || claims.length >= LIMITS.maxClaimsPerDevelopment || !isHttpUrl(url) || url.length > LIMITS.urlChars) return;
			seen.add(key);
			claims.push({ claim_id: `${index + 1}.${claims.length + 1}`, text: clean, source_url: url });
		};
		for (const claim of factClaims(observation)) add(claim.text, claim.url);
		for (const claim of input.modelClaims.filter((item) => item.identityKey === entry.identityKey)) {
			const doc = input.store.getById(claim.sourceDocumentId);
			const url = doc?.finalUrl ?? entry.candidate.sources.find((source) => source.sourceDocumentId === claim.sourceDocumentId)?.url;
			if (url) add(claim.text, url);
		}
		return {
			id: clip(entry.identityKey, LIMITS.developmentIdChars),
			title: clip(facts.company ? `${facts.company} — ${facts.title}` : facts.title, LIMITS.titleChars),
			summary: summarize(facts),
			claims,
		};
	});
}
