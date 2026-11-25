import { createHash } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

export type Extracted = {
	title: string | null;
	text: string;
	sourceKind: "html" | "json" | "text";
	contentHash: string;
	/** Structured fields when the source is a known job-board JSON record. */
	structured?: {
		provider: "greenhouse";
		jobId: string;
		title: string;
		location: string | null;
		updatedAt: string | null;
		absoluteUrl: string | null;
	};
};

const silentConsole = new VirtualConsole();

// JSDOM without runScripts never executes <script>, and without `resources` loads no
// subresources, so parsing an untrusted page cannot run its code or make requests.
function parseHtml(html: string, url?: string) {
	return new JSDOM(html, { url, virtualConsole: silentConsole, contentType: "text/html" });
}

export function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\f\v  -​  　]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/ {2,}/g, " ")
		.trim();
}

function htmlToText(html: string, url?: string): { title: string | null; text: string } {
	const dom = parseHtml(html, url);
	const doc = dom.window.document;
	for (const element of doc.querySelectorAll("script, style, noscript, template, iframe, svg")) element.remove();

	const metaTitle =
		doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? doc.querySelector("title")?.textContent ?? null;

	// Block elements become line breaks so sentences from different paragraphs do not merge.
	for (const element of doc.querySelectorAll("p, div, li, br, h1, h2, h3, h4, h5, h6, tr, section, article, ul, ol")) {
		element.insertAdjacentText("afterend", "\n");
	}

	let text = "";
	try {
		const article = new Readability(doc.cloneNode(true) as Document, { charThreshold: 200 }).parse();
		text = article?.textContent ?? "";
	} catch {
		text = "";
	}
	if (text.trim().length < 200) text = doc.body?.textContent ?? "";
	dom.window.close();
	return { title: metaTitle ? normalizeWhitespace(metaTitle) : null, text: normalizeWhitespace(text) };
}

/** Some job boards emit raw control characters inside JSON strings, which JSON.parse rejects. */
export function parseLenientJson(body: string): unknown {
	return JSON.parse(body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/[\n\r\t]/g, " "));
}

function decodeEntities(html: string): string {
	const dom = parseHtml(`<textarea>${html.replace(/<\/textarea/gi, "&lt;/textarea")}</textarea>`);
	const value = dom.window.document.querySelector("textarea")?.value ?? html;
	dom.window.close();
	return value;
}

type GreenhouseJob = {
	id: number | string;
	title: string;
	content?: string;
	location?: { name?: string } | null;
	updated_at?: string;
	first_published?: string;
	absolute_url?: string;
};

function isGreenhouseJob(value: unknown): value is GreenhouseJob {
	const job = value as GreenhouseJob;
	return Boolean(job && typeof job === "object" && typeof job.title === "string" && job.id !== undefined && "absolute_url" in job);
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function extract(body: string, contentType: string, url: string, maxChars: number): Extracted {
	const type = contentType.toLowerCase();
	let result: Omit<Extracted, "contentHash">;

	if (type.includes("json")) {
		let parsed: unknown;
		try {
			parsed = parseLenientJson(body);
		} catch {
			parsed = null;
		}
		if (isGreenhouseJob(parsed)) {
			// Greenhouse returns the description as entity-escaped HTML.
			const description = parsed.content ? htmlToText(decodeEntities(parsed.content)).text : "";
			const location = parsed.location?.name ?? null;
			const header = [parsed.title, location ? `Location: ${location}` : null].filter(Boolean).join("\n");
			result = {
				title: parsed.title.trim(),
				text: normalizeWhitespace(`${header}\n\n${description}`),
				sourceKind: "json",
				structured: {
					provider: "greenhouse",
					jobId: String(parsed.id),
					title: parsed.title.trim(),
					location,
					updatedAt: parsed.updated_at ?? parsed.first_published ?? null,
					absoluteUrl: parsed.absolute_url ?? null,
				},
			};
		} else {
			result = { title: null, text: normalizeWhitespace(parsed ? JSON.stringify(parsed, null, 1) : body), sourceKind: "json" };
		}
	} else if (type.includes("html")) {
		result = { ...htmlToText(body, url), sourceKind: "html" };
	} else {
		result = { title: null, text: normalizeWhitespace(body), sourceKind: "text" };
	}

	const text = result.text.length > maxChars ? result.text.slice(0, maxChars) : result.text;
	return { ...result, text, contentHash: hashText(text) };
}
