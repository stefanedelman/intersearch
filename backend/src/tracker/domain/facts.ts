import type { TrackerConfig } from "../config";
import type { Extracted } from "../fetch/extract";
import { companyForUrl, identityFor, type Identity } from "./normalize";

// Deterministic fact extraction. Every quote is cut directly from the stored source text, so a
// cited claim cannot be a hallucination; the model never supplies facts, only choices.

export type Evidence = { field: string; quote: string; sourceDocumentId: string; url: string };

export type Facts = {
	companyId: string | null;
	company: string | null;
	title: string;
	locations: string[];
	remote: boolean;
	season: string | null;
	isInternship: boolean;
	skills: string[];
	compensation: string | null;
	eligibility: string[];
	postedAt: string | null;
	applicationUrl: string;
	highlights: string[];
};

export type Observation = {
	identity: Identity;
	facts: Facts;
	evidence: Evidence[];
	source: { sourceDocumentId: string; url: string; title: string | null; fetchedAt: string };
};

const CITIES = [
	"New York",
	"NYC",
	"San Francisco",
	"Seattle",
	"Boston",
	"Menlo Park",
	"Bellevue",
	"Mountain View",
	"Pittsburgh",
	"Chicago",
	"Austin",
	"Denver",
	"Washington",
	"Los Angeles",
	"Toronto",
	"London",
	"Dublin",
	"Paris",
	"Madrid",
	"Singapore",
	"Bengaluru",
	"Bucharest",
	"Tokyo",
	"Sydney",
];

const EXTRA_SKILLS = ["Java", "Go", "Golang", "C++", "C#", "Rust", "Kotlin", "Swift", "JavaScript", "TypeScript", "Python", "Ruby", "Scala", "SQL", "PostgreSQL", "MySQL", "Kubernetes", "Docker", "AWS", "GCP", "React", "distributed systems", "machine learning", "data structures", "algorithms"];

const MAX_QUOTE = 240;

function escapeRegex(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lines, then sentences within long lines; each is an exact substring of the text. */
function segments(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.length <= MAX_QUOTE) out.push(trimmed);
		else out.push(...trimmed.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean));
	}
	return out;
}

/** A quote no longer than MAX_QUOTE that is still an exact substring and contains the match. */
function clip(segment: string, match: RegExpMatchArray | null): string {
	if (segment.length <= MAX_QUOTE || !match || match.index === undefined) return segment.slice(0, MAX_QUOTE);
	const start = Math.max(0, Math.min(match.index - 80, segment.length - MAX_QUOTE));
	return segment.slice(start, start + MAX_QUOTE);
}

function findQuote(segs: string[], pattern: RegExp): { quote: string; match: RegExpMatchArray } | null {
	for (const segment of segs) {
		const match = segment.match(pattern);
		if (match) return { quote: clip(segment, match), match };
	}
	return null;
}

function cleanTitle(raw: string, company: string | null): string {
	const parts = raw.split(/\s+[|–—-]\s+/).map((part) => part.trim()).filter(Boolean);
	const jobPart = parts.find((part) => /intern|engineer|developer|co-?op/i.test(part)) ?? parts[0] ?? raw;
	return company ? jobPart.replace(new RegExp(`^${escapeRegex(company)}\\s+careers\\s*`, "i"), "").trim() : jobPart.trim();
}

const SEASON = /\b(summer|winter|fall|autumn|spring)\b[^\n.]{0,12}?\b(20\d\d)\b|\b(20\d\d)\b\s+(summer|winter|fall|spring)\b/i;

function seasonFrom(text: string): string | null {
	const match = text.match(SEASON);
	if (match) {
		const season = (match[1] ?? match[4] ?? "").toLowerCase().replace("autumn", "fall");
		const year = match[2] ?? match[3];
		return `${season}-${year}`;
	}
	const word = text.match(/\b(summer|winter|fall|spring)\b/i);
	return word ? word[1]!.toLowerCase() : null;
}

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?/;
const BIG_NUMBER = /\b(trillion|billion|million|valuation|raised|funding|revenue|assets)\b/i;
const PAY_WORDS = /\b(pay|salary|compensation|hourly|per hour|an hour|\/\s?h(ou)?r|stipend|wage|base|annual|per year|a year)\b/i;
const RANGE_LINE = /^\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?\s*(?:[-–—]|to)\s*\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s*[A-Z]{3})?$/;

function payPeriod(text: string): string | null {
	if (/hourly|per hour|an hour|\/\s?h(ou)?r/i.test(text)) return "hourly";
	if (/annual|per year|a year|salary/i.test(text)) return "annual";
	if (/per month|monthly/i.test(text)) return "monthly";
	return null;
}

/**
 * Pay: either a sentence that has a dollar amount AND pay wording, or a bare range line such as
 * "$54—$56 USD" whose pay wording is on one of the two lines before it. Dollar amounts about
 * funding, revenue, or assets are ignored.
 */
function findPay(segs: string[]): { quote: string; context: string | null; period: string | null } | null {
	for (let i = 0; i < segs.length; i += 1) {
		const segment = segs[i]!;
		if (!MONEY.test(segment) || BIG_NUMBER.test(segment)) continue;
		if (RANGE_LINE.test(segment.trim())) {
			// The cited context is the line that states the pay period when there is one, so the
			// "(hourly)" or "(annual)" label is itself backed by a quote.
			const periodLine = [segs[i - 1], segs[i - 2], segs[i - 3], segs[i - 4]].find((line) => line && payPeriod(line)) ?? null;
			const context = periodLine ?? [segs[i - 1], segs[i - 2]].find((line) => line && PAY_WORDS.test(line)) ?? null;
			if (context) return { quote: segment, context: clip(context, context.match(PAY_WORDS) ?? context.match(/hourly|annual|year|month/i)), period: periodLine ? payPeriod(periodLine) : null };
			continue;
		}
		if (PAY_WORDS.test(segment)) return { quote: clip(segment, segment.match(MONEY)), context: null, period: payPeriod(segment) };
	}
	return null;
}

const DUTIES_HEADING = /^(what you('|’)ll (do|work on)|what you will do|responsibilities|your role|the role|in this role|about the role|you will)\b/i;
const ACTION_START = /^(build|design|develop|own|ship|write|work|collaborate|contribute|partner|implement|create|maintain|operate|drive|lead|solve|improve|scale)\b/i;

/** Up to three duty lines, preferring those under a "What you'll do" or "Responsibilities" heading. */
function findHighlights(segs: string[]): string[] {
	const out: string[] = [];
	const heading = segs.findIndex((segment) => DUTIES_HEADING.test(segment) && segment.length < 80);
	if (heading >= 0) {
		for (const segment of segs.slice(heading + 1, heading + 12)) {
			if (segment.length < 30) {
				if (out.length) break;
				continue;
			}
			if (/:$/.test(segment) && out.length) break;
			out.push(segment.slice(0, MAX_QUOTE));
			if (out.length === 3) return out;
		}
	}
	for (const segment of segs) {
		if (out.length === 3) break;
		if (segment.length >= 30 && segment.length <= MAX_QUOTE && ACTION_START.test(segment) && !out.includes(segment)) out.push(segment);
	}
	return out;
}

export function extractObservation(input: {
	extracted: Extracted;
	url: string;
	finalUrl: string;
	sourceDocumentId: string;
	fetchedAt: string;
	config: TrackerConfig;
}): Observation {
	const { extracted, config, sourceDocumentId } = input;
	const url = extracted.structured?.absoluteUrl && /^https?:/i.test(extracted.structured.absoluteUrl) ? extracted.structured.absoluteUrl : input.finalUrl;
	const company = companyForUrl(input.finalUrl, config) ?? companyForUrl(input.url, config) ?? companyForUrl(url, config);
	const text = extracted.text;
	const segs = segments(text);
	const evidence: Evidence[] = [];
	const cite = (field: string, quote: string) => {
		if (quote.trim()) evidence.push({ field, quote, sourceDocumentId, url: input.finalUrl });
	};

	// Title: structured JSON title, else the page title, else the first heading-like line. A
	// generic page title such as "Acme Careers" cleans to nothing, so the next candidate is used.
	const cleanedTitle = [extracted.structured?.title, extracted.title, segs[0]].map((candidate) => (candidate ? cleanTitle(candidate, company?.name ?? null) : "")).find(Boolean);
	const title = cleanedTitle ?? "Untitled posting";
	if (cleanedTitle) cite("title", cleanedTitle);

	// Location: structured field, else a labeled "Location" line, else cities near the top.
	let locations: string[] = [];
	if (extracted.structured?.location) {
		locations = extracted.structured.location.split(/;|•|\s\|\s/).map((part) => part.trim()).filter(Boolean);
		const quote = findQuote(segs, new RegExp(escapeRegex(extracted.structured.location.slice(0, 60)), "i"));
		cite("location", quote?.quote ?? `Location: ${extracted.structured.location}`);
	} else {
		const labeled = findQuote(segs, /\b(office )?locations?\s*[:\-]\s*(.{3,160})/i);
		const head = text.slice(0, 1200);
		const cities = CITIES.filter((city) => new RegExp(`\\b${escapeRegex(city)}\\b`, "i").test(labeled?.match[2] ?? head));
		if (cities.length) {
			locations = cities;
			const quote = labeled ?? findQuote(segs, new RegExp(`\\b(${cities.map(escapeRegex).join("|")})\\b`, "i"));
			if (quote) cite("location", quote.quote);
		}
	}

	const remoteQuote = findQuote(segs.slice(0, 40), /\bremote\b/i);
	if (remoteQuote) cite("remote", remoteQuote.quote);

	const titleSeason = seasonFrom(title);
	const seasonQuote = findQuote(segs, SEASON);
	const season = titleSeason && titleSeason.includes("-") ? titleSeason : seasonQuote ? seasonFrom(seasonQuote.quote) : titleSeason;
	if (seasonQuote) cite("season", seasonQuote.quote);
	else if (titleSeason) cite("season", title);

	const isInternship = /\bintern(ship)?s?\b|\bco-?op\b/i.test(title) || /\binternship\b/i.test(text.slice(0, 2000));

	const skills: string[] = [];
	const vocabulary = [...new Set([...config.preferences.skills, ...EXTRA_SKILLS])];
	for (const skill of vocabulary) {
		const pattern = skill === "Go" ? /\bGo\b(?![- ]?(?:to|live|beyond|ahead|fast))/ : new RegExp(`(?<![A-Za-z0-9])${escapeRegex(skill)}(?![A-Za-z0-9+#])`, "i");
		const found = findQuote(segs, pattern);
		if (found) {
			skills.push(skill === "Golang" ? "Go" : skill);
			cite(`skill:${skill}`, found.quote);
		}
	}

	const pay = findPay(segs);
	if (pay) {
		cite("compensation", pay.quote);
		if (pay.context) cite("compensation", pay.context);
	}

	const eligibility: string[] = [];
	for (const segment of segs) {
		const match = segment.match(/graduat|currently (?:enrolled|pursuing)|pursuing an? (?:bachelor|master|ph\.?d|degree)|work authori[sz]ation|visa sponsorship|sponsor(?:ship)?|class of 20\d\d|returning to school/i);
		if (match && eligibility.length < 3) {
			const quote = clip(segment, match);
			eligibility.push(quote);
			cite("eligibility", quote);
		}
	}

	const highlights = findHighlights(segs);
	highlights.forEach((quote) => cite("highlight", quote));

	const facts: Facts = {
		companyId: company?.id ?? null,
		company: company?.name ?? null,
		title,
		locations,
		remote: Boolean(remoteQuote),
		season,
		isInternship,
		skills: [...new Set(skills)],
		compensation: pay ? `${pay.quote}${pay.period ? ` (${pay.period})` : ""}` : null,
		eligibility,
		postedAt: extracted.structured?.updatedAt ?? null,
		applicationUrl: url,
		highlights,
	};

	const identity = identityFor({
		company,
		jobId: extracted.structured?.jobId,
		url: input.finalUrl,
		title,
		location: locations.join("; ") || null,
		season,
	});

	return { identity, facts, evidence, source: { sourceDocumentId, url: input.finalUrl, title: extracted.title, fetchedAt: input.fetchedAt } };
}
