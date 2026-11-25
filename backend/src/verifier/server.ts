import { z } from "zod";
import { verifyRequestSchema, verifyResponseSchema, type VerifyPayload, type VerifyResult } from "../shared/contract";
import { loadLocalEnv } from "../shared/load-env";
import { createGroqModel } from "../shared/providers/groq";
import { TraceLog } from "../shared/trace-log";
import { createWorkerApp, listenWorker } from "../shared/worker/app";
import { defaultTraceFile, optionalEnvString, parseEnv, serviceToken } from "../shared/worker-env";
import { createVerifyHandler } from "./verify";

/**
 * The verifier service. Deployed on Render's free tier; also runs locally (`npm run dev:verifier`).
 * It needs only its own token and model key: no database, no Supabase, no researcher secrets.
 */
const verifierEnvSchema = z.object({
	APP_ENV: z.enum(["development", "test", "production"]).default("development"),
	/** Render sets PORT; locally VERIFIER_PORT (default 4002). */
	PORT: z.coerce.number().int().positive().optional(),
	VERIFIER_PORT: z.coerce.number().int().positive().default(4002),
	VERIFIER_TOKEN: serviceToken("VERIFIER_TOKEN"),
	VERIFIER_GROQ_API_KEY: z.string({ error: "VERIFIER_GROQ_API_KEY is required" }).trim().min(1, "VERIFIER_GROQ_API_KEY is required"),
	VERIFIER_MODEL: z.string({ error: "VERIFIER_MODEL is required (a Groq model id, different from the researcher's)" }).trim().min(1),
	VERIFIER_TRACE_FILE: optionalEnvString,
	VERIFIER_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4),
});

async function main() {
	loadLocalEnv();
	const env = parseEnv(verifierEnvSchema, "verifier");
	const log = new TraceLog("verifier", { file: env.VERIFIER_TRACE_FILE ?? defaultTraceFile("verifier", env.APP_ENV), stdout: env.APP_ENV === "production" });
	const callModel = createGroqModel(env.VERIFIER_GROQ_API_KEY, 30_000);
	const { app } = createWorkerApp<VerifyPayload, VerifyResult>({
		service: "verifier",
		token: env.VERIFIER_TOKEN,
		log,
		maxConcurrent: env.VERIFIER_MAX_CONCURRENT,
		route: {
			path: "/verify",
			requestSchema: verifyRequestSchema,
			responseSchema: verifyResponseSchema,
			emptyResult: { verdicts: [] },
			handle: createVerifyHandler({ callModel, model: env.VERIFIER_MODEL }),
		},
	});
	const port = env.PORT ?? env.VERIFIER_PORT;
	await listenWorker(app, port);
	console.error(`verifier listening on :${port} (model ${env.VERIFIER_MODEL})`);
}

main().catch((error) => {
	console.error(`verifier failed to start: ${(error as Error).message}`);
	process.exit(1);
});
