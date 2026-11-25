import { serverEnv } from "./lib/env";
import { createApp } from "./app";
import { logger } from "./lib/logger";
import { createJobRunner, settingsFromEnv } from "./orchestrator/jobs";
import { supabaseAuthProvider } from "./services/supabase-auth-provider";

const { PORT } = serverEnv();
const runner = createJobRunner(settingsFromEnv());

// Runs left "running" by a previous process (a crash, or tsx watch restarting) can never finish.
runner
	.sweep()
	.then((ids) => {
		if (ids.length) logger.info("Closed orchestrated runs left over from a previous process", { runIds: ids });
	})
	.catch((error) => logger.error("Startup sweep failed", { error: String(error) }));

const missing = runner.missingTokens();
if (missing.length) console.warn(`! ${missing.join(" and ")} not set: the dashboard can show runs but cannot start one (backend/.env.local).`);

createApp({ authProvider: supabaseAuthProvider, runner }).listen(PORT, () => {
	console.log(`Intersearch API running on http://localhost:${PORT}`);
	console.log(`  researcher ${runner.settings.researcher.url} · verifier ${runner.settings.verifier.url}`);
});
