import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// backend/.env (course Supabase settings) and backend/.env.local (provider keys) are both local and
// git-ignored. Later files override earlier ones; real environment variables win over both.
const backendRoot = path.resolve(__dirname, "../..");
const shellKeys = new Set(Object.keys(process.env));
// Automated tests provide their own environment and must not pick up the course project's values.
for (const file of process.env.APP_ENV === "test" ? [] : [".env", ".env.local"]) {
	const parsed = dotenv.config({ path: path.join(backendRoot, file), processEnv: {}, quiet: true }).parsed ?? {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!shellKeys.has(key)) process.env[key] = value;
	}
}

const optionalString = z
	.string()
	.optional()
	.transform((value) => (value && value.trim() !== "" ? value.trim() : undefined));

const serverSchema = z.object({
	APP_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),
	DATABASE_URL: z.string().min(1, "DATABASE_URL is required (see backend/.env.example)"),
	SUPABASE_URL: z.url("SUPABASE_URL must be the course Supabase project URL"),
	SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, "SUPABASE_SERVICE_ROLE_KEY is required"),
	CORS_ALLOWED_ORIGINS: z
		.string()
		.default("http://localhost:5173")
		.transform((value) =>
			value
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean),
		),
	AUTH_PLACEHOLDER_EMAIL_DOMAIN: z.string().default("users.intersearch.test"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
	if (cached) return cached;
	const placeholders = ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((key) => process.env[key]?.startsWith("REPLACE_WITH_"));
	for (const key of ["DATABASE_URL", "DIRECT_URL"]) if (process.env[key]?.includes("[YOUR-PASSWORD]")) placeholders.push(`${key} ([YOUR-PASSWORD])`);
	if (placeholders.length) {
		throw new Error(`backend/.env still has placeholder values for ${placeholders.join(", ")}. Fill them in from the course Supabase project (README: "Supabase setup").`);
	}
	const result = serverSchema.safeParse(process.env);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
		throw new Error(`Invalid backend environment:\n${problems.join("\n")}`);
	}
	cached = result.data;
	return cached;
}

const trackerSchema = z.object({
	TRACKER_API_BASE_URL: z.string().default("http://localhost:3000"),
	TRACKER_USERNAME: optionalString,
	TRACKER_PASSWORD: optionalString,
	TRACKER_CONFIG_PATH: z.string().default(path.resolve(backendRoot, "..", "config.yaml")),
	GROQ_API_KEY: optionalString,
	TAVILY_API_KEY: optionalString,
});

export type TrackerEnv = z.infer<typeof trackerSchema>;

// The tracker and standalone tools never need database or Supabase credentials.
export function trackerEnv(): TrackerEnv {
	return trackerSchema.parse(process.env);
}

export const paths = {
	backendRoot,
	repoRoot: path.resolve(backendRoot, ".."),
};
