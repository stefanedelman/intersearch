import path from "node:path";
import { z } from "zod";
import { paths } from "../lib/env";

const optional = z
	.string()
	.optional()
	.transform((value) => (value && value.trim() !== "" ? value.trim() : undefined));

const schema = z.object({
	RESEARCHER_URL: z.url().default("http://127.0.0.1:4001"),
	VERIFIER_URL: z.url().default("http://127.0.0.1:4002"),
	// Optional so the A1 API still boots without them; starting a run without them is a 503 that names the missing one.
	RESEARCHER_TOKEN: optional,
	VERIFIER_TOKEN: optional,
	TRACKER_CONFIG_PATH: z.string().default(path.join(paths.repoRoot, "config.yaml")),
	TRACKER_RUNS_DIR: z.string().default(path.join(paths.repoRoot, "runs")),
});

export type OrchestratorEnv = z.infer<typeof schema>;

/** The API process's view of the workers. Read from backend/.env and .env.local (loaded by lib/env). */
export function orchestratorEnv(): OrchestratorEnv {
	const result = schema.safeParse(process.env);
	if (!result.success) {
		const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
		throw new Error(`Invalid orchestrator environment:\n${problems.join("\n")}`);
	}
	return result.data;
}
