import { serverEnv } from "./lib/env";
import { createApp } from "./app";
import { supabaseAuthProvider } from "./services/supabase-auth-provider";

const { PORT } = serverEnv();

createApp({ authProvider: supabaseAuthProvider }).listen(PORT, () => {
	console.log(`Intersearch API running on http://localhost:${PORT}`);
});
