import path from "node:path";
import dotenv from "dotenv";

/** backend/ (two levels above this file in both src/ and dist/). */
export const backendRoot = path.resolve(__dirname, "../..");

/**
 * Loads backend/.env then backend/.env.local into process.env for local development. Later files
 * override earlier ones; variables already set in the real environment win over both (on Render
 * there are no files, so only the dashboard's environment settings apply). Skipped under
 * APP_ENV=test so tests never pick up real credentials.
 */
export function loadLocalEnv() {
	if (process.env.APP_ENV === "test") return;
	const shellKeys = new Set(Object.keys(process.env));
	for (const file of [".env", ".env.local"]) {
		const parsed = dotenv.config({ path: path.join(backendRoot, file), processEnv: {}, quiet: true }).parsed ?? {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!shellKeys.has(key)) process.env[key] = value;
		}
	}
}
