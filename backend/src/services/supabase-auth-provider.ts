import { isAuthApiError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { createSignInClient, supabase } from "../lib/supabase";
import { errors } from "../lib/errors";
import { toAppError, type AuthProvider, type AuthUser } from "./auth-provider";

function toAuthUser(user: { id: string; email?: string | null }): AuthUser {
	return { id: user.id, email: user.email ?? null };
}

export const supabaseAuthProvider: AuthProvider = {
	async createUser({ email, password, username }) {
		// Admin creation marks the email confirmed and sends no email.
		const { data, error } = await supabase.auth.admin.createUser({
			email,
			password,
			email_confirm: true,
			user_metadata: { username },
		});
		if (error || !data.user) throw error ? toAppError(error) : errors.unavailable("User creation failed.");
		return toAuthUser(data.user);
	},

	async signIn(email, password) {
		const { data, error } = await createSignInClient().auth.signInWithPassword({ email, password });
		if (error) {
			if (isAuthApiError(error) && (error.code === "invalid_credentials" || error.status === 400)) return null;
			throw toAppError(error);
		}
		if (!data.session) return null;
		const expiresAt = new Date((data.session.expires_at ?? Date.now() / 1000 + data.session.expires_in) * 1000);
		return { accessToken: data.session.access_token, expiresAt: expiresAt.toISOString() };
	},

	async verifyToken(token) {
		// Same check as Cirilio's requireAuth: Supabase validates signature, expiry, session, and user.
		const { data, error } = await supabase.auth.getUser(token);
		if (error) {
			if (isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500) throw toAppError(error);
			return null;
		}
		return data.user ? toAuthUser(data.user) : null;
	},

	async getUser(id) {
		const { data, error } = await supabase.auth.admin.getUserById(id);
		if (error) {
			if (isAuthApiError(error) && error.status === 404) return null;
			throw toAppError(error);
		}
		return data.user ? toAuthUser(data.user) : null;
	},

	async updateUser(id, changes) {
		const { error } = await supabase.auth.admin.updateUserById(id, {
			...(changes.email ? { email: changes.email, email_confirm: true } : {}),
			...(changes.password ? { password: changes.password } : {}),
		});
		if (error) throw toAppError(error);
	},

	async deleteUser(id) {
		const { error } = await supabase.auth.admin.deleteUser(id);
		if (error && !(isAuthApiError(error) && error.status === 404)) throw toAppError(error);
	},
};
