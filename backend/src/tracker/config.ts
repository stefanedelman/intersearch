import fs from "node:fs";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";

const MAX_CONFIG_BYTES = 64 * 1024;

// Server ceilings: config.yaml may lower any limit but never raise one above these.
export const LIMIT_CEILINGS = {
	max_steps: 40,
	max_model_calls: 40,
	max_tool_calls: 80,
	max_searches: 10,
	max_fetches: 30,
	max_network_requests: 150,
	max_total_tokens: 200_000,
	max_search_credits: 10,
	max_elapsed_seconds: 900,
	max_retries: 4,
	request_timeout_seconds: 30,
	max_response_bytes: 5_000_000,
	max_extracted_characters: 50_000,
	max_redirects: 5,
} as const;

const TOOL_NAMES = ["search_web", "fetch_article", "list_company_jobs", "finish"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const hostname = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, "must be an exact DNS hostname")
	.refine((host) => !/^\d+(\.\d+){3}$/.test(host), "IP addresses are not allowed; use a hostname");

const limit = (key: keyof typeof LIMIT_CEILINGS) => z.number().int().positive().max(LIMIT_CEILINGS[key]);

const limitsSchema = z
	.object({
		max_steps: limit("max_steps"),
		max_model_calls: limit("max_model_calls"),
		max_tool_calls: limit("max_tool_calls"),
		max_searches: z.number().int().min(0).max(LIMIT_CEILINGS.max_searches),
		max_fetches: limit("max_fetches"),
		max_network_requests: limit("max_network_requests"),
		max_total_tokens: limit("max_total_tokens"),
		max_search_credits: z.number().min(0).max(LIMIT_CEILINGS.max_search_credits),
		max_elapsed_seconds: limit("max_elapsed_seconds"),
		max_retries: z.number().int().min(0).max(LIMIT_CEILINGS.max_retries),
		request_timeout_seconds: limit("request_timeout_seconds"),
		max_response_bytes: z.number().int().min(1024).max(LIMIT_CEILINGS.max_response_bytes),
		max_extracted_characters: z.number().int().min(500).max(LIMIT_CEILINGS.max_extracted_characters),
		max_redirects: z.number().int().min(0).max(LIMIT_CEILINGS.max_redirects),
	})
	.strict();

const companySchema = z
	.object({
		id: z.string().regex(/^[a-z0-9-]{1,40}$/, "company id must be lowercase letters, digits, or dashes"),
		name: z.string().min(1).max(80),
		careers_url: z.url(),
		adapter: z.enum(["greenhouse", "none"]),
		board_token: z
			.string()
			.regex(/^[a-z0-9-]{1,60}$/)
			.optional(),
		permission_notes: z.string().max(500).optional(),
	})
	.strict()
	.refine((company) => company.adapter !== "greenhouse" || company.board_token, {
		message: "greenhouse companies need a board_token",
	});

export const trackerConfigSchema = z
	.object({
		schema_version: z.literal(1),
		tracker: z
			.object({
				name: z.string().min(1).max(80),
				topic: z.string().min(5).max(300),
				k: z.number().int().min(3, "K must be between 3 and 10").max(10, "K must be between 3 and 10"),
				season: z.string().regex(/^(spring|summer|fall|winter)-\d{4}$/, "season looks like summer-2027"),
			})
			.strict(),
		preferences: z
			.object({
				roles: z.array(z.string().min(2).max(60)).min(1).max(10),
				locations: z.array(z.string().min(2).max(60)).max(10),
				remote_allowed: z.boolean(),
				remote_region: z.string().max(40).nullable(),
				skills: z.array(z.string().min(1).max(40)).max(25),
				degree: z.string().max(80).nullable(),
				graduation_date: z.string().max(40).nullable(),
				work_authorization: z.string().max(80).nullable(),
			})
			.strict(),
		model: z
			.object({
				provider: z.literal("groq"),
				id: z.string().min(1).max(100),
				temperature: z.number().min(0).max(1),
				max_output_tokens: z.number().int().min(100).max(4000),
			})
			.strict(),
		instructions: z.string().min(20).max(4000),
		tools: z
			.array(z.enum(TOOL_NAMES))
			.min(1)
			.refine((tools) => new Set(tools).size === tools.length, "tools must not repeat")
			.refine((tools) => tools.includes("fetch_article") && tools.includes("finish"), "fetch_article and finish are required"),
		limits: limitsSchema,
		fetch_policy: z
			.object({
				allowed_schemes: z
					.array(z.enum(["http", "https"], { message: "only http and https are allowed" }))
					.min(1),
				allowed_ports: z.array(z.number().int().min(1).max(65535)).min(1),
				allowed_hosts: z.array(hostname).min(1, "allowed_hosts is empty; list the exact hosts the tracker may fetch"),
			})
			.strict(),
		seed_urls: z.array(z.url()).max(10).default([]),
		companies: z.array(companySchema).min(1, "companies is empty; configure at least one company").max(10),
		ranking: z
			.object({
				role_weight: z.number().min(0),
				season_weight: z.number().min(0),
				location_weight: z.number().min(0),
				skills_weight: z.number().min(0),
				freshness_weight: z.number().min(0),
			})
			.strict()
			.refine(
				(weights) => Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 100) < 1e-9,
				"ranking weights must sum to 100",
			),
	})
	.strict()
	.superRefine((config, ctx) => {
		const allowed = new Set(config.fetch_policy.allowed_hosts);
		config.seed_urls.forEach((url, index) => {
			const host = new URL(url).hostname.toLowerCase();
			if (!allowed.has(host)) {
				ctx.addIssue({ code: "custom", path: ["seed_urls", index], message: `host ${host} is not in fetch_policy.allowed_hosts` });
			}
			const scheme = new URL(url).protocol.replace(":", "");
			if (!config.fetch_policy.allowed_schemes.includes(scheme as "http" | "https")) {
				ctx.addIssue({ code: "custom", path: ["seed_urls", index], message: `scheme ${scheme} is not allowed` });
			}
		});
		const ids = config.companies.map((company) => company.id);
		if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["companies"], message: "company ids must be unique" });
		const text = JSON.stringify(config);
		if (/<[A-Z_]+>|TODO|CHANGEME/.test(text)) {
			ctx.addIssue({ code: "custom", path: [], message: "config contains an unresolved placeholder" });
		}
	});

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;

export class ConfigError extends Error {}

export function parseConfig(source: string): TrackerConfig {
	if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) throw new ConfigError("config.yaml is larger than 64 KB.");
	let raw: unknown;
	try {
		// Plain YAML 1.2 core schema: no custom tags, bounded aliases.
		raw = YAML.parse(source, { schema: "core", maxAliasCount: 20, uniqueKeys: true });
	} catch (error) {
		throw new ConfigError(`config.yaml is not valid YAML: ${(error as Error).message}`);
	}
	const result = trackerConfigSchema.safeParse(raw);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
		throw new ConfigError(`config.yaml is invalid:\n${problems.join("\n")}`);
	}
	return result.data;
}

export function loadConfig(filePath: string): TrackerConfig {
	if (!fs.existsSync(filePath)) throw new ConfigError(`config file not found: ${filePath}`);
	return parseConfig(fs.readFileSync(filePath, "utf8"));
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Hash of the whole resolved config, for transparency. */
export function configHash(config: TrackerConfig): string {
	return sha256(canonicalJson(config));
}

/**
 * Hash of only the tracking target. Runs are compared against the previous complete run with
 * the same key, so editing limits, model, instructions, or fetch policy keeps comparisons intact.
 */
export function comparisonKey(config: TrackerConfig): string {
	return sha256(
		canonicalJson({
			tracker: { topic: config.tracker.topic, k: config.tracker.k, season: config.tracker.season },
			preferences: config.preferences,
			companies: config.companies.map((company) => ({ id: company.id, board_token: company.board_token ?? null })),
		}),
	);
}
