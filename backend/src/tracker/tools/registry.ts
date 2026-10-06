import { z } from "zod";
import type { ToolName } from "../config";
import type { ModelTool } from "../providers/groq";
import { finishArgsSchema } from "./finish";

// The registry is frozen per run from config.yaml. Tool names and arguments from the model are
// validated here; nothing in a tool call can add tools, change hosts, or alter budgets.

export const toolArgSchemas = {
	search_web: z.object({ query: z.string().min(2).max(300) }).strict(),
	fetch_article: z.object({ url: z.string().min(1).max(2048) }).strict(),
	list_company_jobs: z.object({ company_id: z.string().min(1).max(40) }).strict(),
	finish: finishArgsSchema,
} as const;

const definitions: Record<ToolName, ModelTool> = {
	list_company_jobs: {
		type: "function",
		function: {
			name: "list_company_jobs",
			description: "List current internship postings from one configured company's public job board. Returns job titles, locations, and a fetch_url for each posting.",
			parameters: {
				type: "object",
				properties: { company_id: { type: "string", description: "A configured company id, e.g. \"stripe\"." } },
				required: ["company_id"],
				additionalProperties: false,
			},
		},
	},
	search_web: {
		type: "function",
		function: {
			name: "search_web",
			description: "Web search restricted to the allowed hosts. Use only to find postings the company feeds miss. Results are hints; fetch them before relying on them.",
			parameters: {
				type: "object",
				properties: { query: { type: "string", description: "Search query, e.g. \"Figma software engineer intern summer 2027 New York\"." } },
				required: ["query"],
				additionalProperties: false,
			},
		},
	},
	fetch_article: {
		type: "function",
		function: {
			name: "fetch_article",
			description: "Fetch one posting page (http/https, allowlisted hosts only). Returns a source_id, facts extracted by code, and an excerpt. Already-fetched pages are reused without a new request.",
			parameters: {
				type: "object",
				properties: { url: { type: "string", description: "The posting URL, e.g. a fetch_url from list_company_jobs." } },
				required: ["url"],
				additionalProperties: false,
			},
		},
	},
	finish: {
		type: "function",
		function: {
			name: "finish",
			description: "End the research. List the fetched postings you consider the best matches (by source_id). Optionally select a quote copied exactly from that posting. Do not add any interpretation or factual claim. Code ranks and writes the report.",
			parameters: {
				type: "object",
				properties: {
					candidates: {
						type: "array",
						maxItems: 20,
						items: {
							type: "object",
							properties: {
								source_id: { type: "string" },
								supporting_quote: { type: "string", description: "Exact words copied from the posting, with no added claims." },
							},
							required: ["source_id"],
							additionalProperties: false,
						},
					},
				},
				required: ["candidates"],
				additionalProperties: false,
			},
		},
	},
};

export function toolDefinitions(enabled: readonly ToolName[]): ModelTool[] {
	return enabled.map((name) => definitions[name]);
}

export type ParsedToolCall =
	| { ok: true; name: ToolName; args: Record<string, unknown> }
	| { ok: false; name: string; error: string };

/** Unknown tools, disabled tools, bad JSON, and schema violations are rejected before execution. */
export function parseToolCall(enabled: readonly ToolName[], name: string, rawArguments: string): ParsedToolCall {
	if (!(name in toolArgSchemas) || !enabled.includes(name as ToolName)) {
		return { ok: false, name, error: `Unknown tool "${name}". Available tools: ${enabled.join(", ")}.` };
	}
	let parsed: unknown;
	try {
		parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
	} catch {
		return { ok: false, name, error: "Tool arguments were not valid JSON." };
	}
	const result = toolArgSchemas[name as ToolName].safeParse(parsed);
	if (!result.success) {
		return { ok: false, name, error: `Invalid arguments for ${name}: ${result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}` };
	}
	return { ok: true, name: name as ToolName, args: result.data as Record<string, unknown> };
}
