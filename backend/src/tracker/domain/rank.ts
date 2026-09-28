import type { TrackerConfig } from "../config";
import type { Facts } from "./facts";

export type ScoreBreakdown = { role: number; season: number; location: number; skills: number; freshness: number };

export type Scored = {
	score: number;
	breakdown: ScoreBreakdown;
	excluded: string | null;
	notes: string[];
	unknowns: string[];
};

const DAY = 86_400_000;

function roleFit(title: string, roles: string[]): number {
	const t = title.toLowerCase();
	const wantsBackend = roles.some((role) => /backend|back-end/i.test(role));
	if (wantsBackend && /backend|back-end|infrastructure|platform|distributed/.test(t)) return 1;
	if (/software (engineer|developer|engineering)|swe\b/.test(t)) return 1;
	if (/engineer|developer/.test(t) && !/data|machine learning|ml\b|analytics|reliability|integration|hardware|mechanical|sales|solutions/.test(t)) return 0.7;
	if (/engineer|developer/.test(t)) return 0.35;
	return 0;
}

function seasonFit(season: string | null, wanted: string): { value: number; excluded: string | null } {
	const [wantedSeason, wantedYear] = wanted.split("-");
	if (!season) return { value: 0, excluded: null };
	const [foundSeason, foundYear] = season.split("-");
	if (foundYear && wantedYear && foundYear !== wantedYear) return { value: 0, excluded: `posting is for ${season}, not ${wanted}` };
	if (foundSeason === wantedSeason) return { value: foundYear ? 1 : 0.6, excluded: null };
	return { value: 0.2, excluded: null };
}

function locationFit(facts: Facts, config: TrackerConfig): { value: number; excluded: string | null } {
	const preferred = config.preferences.locations.map((location) => location.toLowerCase());
	const all = facts.locations.map((location) => location.toLowerCase());
	const matches = (location: string) => preferred.some((want) => location.includes(want) || (want === "new york" && /\bnyc\b/.test(location)));
	if (all.some(matches)) return { value: 1, excluded: null };
	if (config.preferences.remote_allowed && facts.remote) return { value: 0.7, excluded: null };
	if (all.length > 0 && preferred.length > 0) return { value: 0, excluded: `location (${facts.locations.join(", ")}) is outside your preferred locations` };
	return { value: 0, excluded: null };
}

function skillFit(skills: string[], wanted: string[]): number {
	if (wanted.length === 0) return 0;
	const have = new Set(skills.map((skill) => skill.toLowerCase()));
	const overlap = wanted.filter((skill) => have.has(skill.toLowerCase())).length;
	return Math.min(1, overlap / Math.min(3, wanted.length));
}

function freshnessFit(postedAt: string | null, firstSeenAt: string | null, now: Date): { value: number; note: string | null } {
	if (postedAt) {
		const age = (now.getTime() - new Date(postedAt).getTime()) / DAY;
		return { value: age <= 7 ? 1 : age <= 30 ? 0.6 : 0.2, note: null };
	}
	if (firstSeenAt) {
		const age = (now.getTime() - new Date(firstSeenAt).getTime()) / DAY;
		return { value: age <= 7 ? 0.5 : 0.2, note: "No posting date; freshness uses when Intersearch first saw it." };
	}
	return { value: 0, note: null };
}

/**
 * Deterministic score out of 100: the model never sets a score. Hard exclusions apply first;
 * missing facts score zero in their dimension and are listed as unknowns rather than guessed.
 */
export function scoreFacts(facts: Facts, config: TrackerConfig, options: { firstSeenAt?: string | null; now?: Date } = {}): Scored {
	const weights = config.ranking;
	const notes: string[] = [];
	const unknowns: string[] = [];

	let excluded: string | null = null;
	if (!facts.companyId) excluded = "posting is not from one of the configured companies";
	if (!facts.isInternship) excluded ??= "posting is not an internship";

	const role = roleFit(facts.title, config.preferences.roles);
	if (role === 0) excluded ??= "role does not match your target roles";

	const season = seasonFit(facts.season, config.tracker.season);
	const location = locationFit(facts, config);
	excluded ??= season.excluded ?? location.excluded;

	if (!facts.season) unknowns.push("season");
	if (facts.locations.length === 0 && !facts.remote) unknowns.push("location");
	if (facts.eligibility.length === 0) unknowns.push("eligibility");
	if (!facts.compensation) unknowns.push("compensation");

	const freshness = freshnessFit(facts.postedAt, options.firstSeenAt ?? null, options.now ?? new Date());
	if (freshness.note) notes.push(freshness.note);

	const breakdown: ScoreBreakdown = {
		role: round(weights.role_weight * role),
		season: round(weights.season_weight * season.value),
		location: round(weights.location_weight * location.value),
		skills: round(weights.skills_weight * skillFit(facts.skills, config.preferences.skills)),
		freshness: round(weights.freshness_weight * freshness.value),
	};
	const score = round(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
	return { score, breakdown, excluded, notes, unknowns };
}

function round(value: number) {
	return Math.round(value * 10) / 10;
}

/** Stable ordering: score, then company, title, identity key. */
export function compareRanked(
	a: { score: number; company: string | null; title: string; identityKey: string },
	b: { score: number; company: string | null; title: string; identityKey: string },
): number {
	return b.score - a.score || (a.company ?? "").localeCompare(b.company ?? "") || a.title.localeCompare(b.title) || a.identityKey.localeCompare(b.identityKey);
}
