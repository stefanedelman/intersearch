import path from "node:path";
import { z } from "zod";
import { backendRoot } from "./load-env";

const optional = z
	.string()
	.optional()
	.transform((value) => (value && value.trim() !== "" ? value.trim() : undefined));

/** Service tokens are long random strings (`openssl rand -hex 32`); a short one is a mistake. */
export const serviceToken = (name: string) =>
	z
		.string({ error: `${name} is required` })
		.trim()
		.min(24, `${name} must be at least 24 characters (generate one with: openssl rand -hex 32)`);

/** Where a worker appends its JSONL trace. Default: traces/live/<service>.jsonl locally; stdout only in production (Render). */
export function defaultTraceFile(service: string, appEnv: string | undefined): string | null {
	return appEnv === "production" ? null : path.resolve(backendRoot, "..", "traces", "live", `${service}.jsonl`);
}

export function parseEnv<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
	const result = schema.safeParse(process.env);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`);
		throw new Error(`Invalid ${label} environment:\n${problems.join("\n")}`);
	}
	return result.data;
}

export { optional as optionalEnvString };
