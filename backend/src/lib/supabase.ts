import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "./env";

const clientOptions = {
	auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

// Server-only admin client, as in Cirilio. Never sent to the frontend or the tracker.
export const supabase: SupabaseClient = createClient(
	serverEnv().SUPABASE_URL,
	serverEnv().SUPABASE_SERVICE_ROLE_KEY,
	clientOptions,
);

// signInWithPassword stores the session on the client it is called on, so each sign-in
// gets its own short-lived client instead of mutating the shared admin client.
export function createSignInClient(): SupabaseClient {
	return createClient(serverEnv().SUPABASE_URL, serverEnv().SUPABASE_SERVICE_ROLE_KEY, clientOptions);
}
