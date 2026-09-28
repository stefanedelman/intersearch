import { computed, reactive } from "vue";
import { authApi, type Session, type User } from "../api/auth";
import { configureApi } from "../api/client";

// The access token lives in memory and in sessionStorage so a page reload keeps you signed in
// for this tab only. Tradeoff: an XSS bug could read sessionStorage, which is why all web-derived
// text is rendered as plain text (never v-html). Passwords are never stored.
const STORAGE_KEY = "intersearch.session";

const state = reactive<{ token: string | null; expiresAt: string | null; user: User | null }>({
	token: null,
	expiresAt: null,
	user: null,
});

let onSignedOut: (() => void) | undefined;

function persist() {
	try {
		if (state.token) {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: state.token, expiresAt: state.expiresAt, user: state.user }));
		} else {
			sessionStorage.removeItem(STORAGE_KEY);
		}
	} catch {
		// Storage can be unavailable (private mode); the in-memory session still works.
	}
}

function restore() {
	try {
		const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Session | null;
		if (saved?.token && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now()) {
			state.token = saved.token;
			state.expiresAt = saved.expiresAt;
			state.user = saved.user;
		}
	} catch {
		sessionStorage.removeItem(STORAGE_KEY);
	}
}

function setSession(session: Session) {
	state.token = session.token;
	state.expiresAt = session.expiresAt;
	state.user = session.user;
	persist();
}

function clearSession() {
	state.token = null;
	state.expiresAt = null;
	state.user = null;
	persist();
}

restore();

configureApi({
	getToken: () => {
		if (state.expiresAt && new Date(state.expiresAt).getTime() <= Date.now()) {
			clearSession();
			onSignedOut?.();
			return null;
		}
		return state.token;
	},
	onUnauthorized: () => {
		clearSession();
		onSignedOut?.();
	},
});

export function onSessionEnded(callback: () => void) {
	onSignedOut = callback;
}

export function useAuth() {
	return {
		user: computed(() => state.user),
		isSignedIn: computed(() => Boolean(state.token)),

		async login(username: string, password: string) {
			setSession(await authApi.login({ username, password }));
		},

		async register(input: { username: string; password: string; email?: string }) {
			setSession(await authApi.register(input));
		},

		async refresh() {
			if (!state.token) return;
			state.user = (await authApi.me()).user;
			persist();
		},

		/** Confirms the current password by signing in again before a password change. */
		async verifyPassword(password: string) {
			if (!state.user) return false;
			try {
				await authApi.login({ username: state.user.username, password });
				return true;
			} catch {
				return false;
			}
		},

		async update(changes: { email?: string; password?: string }) {
			if (!state.user) return;
			state.user = (await authApi.updateUser(state.user.id, changes)).user;
			persist();
		},

		async deleteAccount() {
			if (!state.user) return;
			await authApi.deleteUser(state.user.id);
			clearSession();
		},

		logout() {
			clearSession();
		},
	};
}
