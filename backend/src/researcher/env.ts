import path from "node:path";
import { z } from "zod";
import { backendRoot, loadLocalEnv } from "../shared/load-env";
import { optionalEnvString, parseEnv, serviceToken } from "../shared/worker-env";

const configPath = z.string().default(path.resolve(backendRoot, "..", "config.yaml"));

/** What the model-free tool CLI needs: the config file and, for search_web, the Tavily key. */
export function toolEnv() {
	loadLocalEnv();
	return parseEnv(z.object({ TRACKER_CONFIG_PATH: configPath, TAVILY_API_KEY: optionalEnvString }), "researcher tools");
}

/** The researcher service: its own token and the model/search keys. No database or Supabase settings. */
export function researcherEnv() {
	loadLocalEnv();
	return parseEnv(
		z.object({
			APP_ENV: z.enum(["development", "test", "production"]).default("development"),
			RESEARCHER_PORT: z.coerce.number().int().positive().default(4001),
			RESEARCHER_HOST: z.string().default("127.0.0.1"),
			RESEARCHER_TOKEN: serviceToken("RESEARCHER_TOKEN"),
			GROQ_API_KEY: z.string({ error: "GROQ_API_KEY is required (backend/.env.local)" }).trim().min(1, "GROQ_API_KEY is required (backend/.env.local)"),
			TAVILY_API_KEY: optionalEnvString,
			TRACKER_CONFIG_PATH: configPath,
			RESEARCHER_TRACE_FILE: optionalEnvString,
		}),
		"researcher",
	);
}
