import { randomBytes, randomUUID } from "node:crypto";
import { errors } from "../../src/lib/errors";
import type { AuthProvider } from "../../src/services/auth-provider";

// In-memory stand-in for Supabase Auth with the behaviors the API depends on:
// tokens survive password changes, and deleting a user invalidates their tokens.
export function createFakeAuthProvider(options: { tokenTtlMs?: number } = {}) {
	const users = new Map<string, { id: string; email: string; password: string }>();
	const tokens = new Map<string, { userId: string; expiresAt: number }>();
	let available = true;

	const provider: AuthProvider = {
		async createUser({ email, password }) {
			if ([...users.values()].some((user) => user.email === email)) {
				throw errors.conflict("EMAIL_TAKEN", "That email is already in use.");
			}
			const user = { id: randomUUID(), email, password };
			users.set(user.id, user);
			return { id: user.id, email };
		},
		async signIn(email, password) {
			const user = [...users.values()].find((candidate) => candidate.email === email);
			if (!user || user.password !== password) return null;
			const token = `fake.${randomBytes(16).toString("hex")}`;
			const expiresAt = Date.now() + (options.tokenTtlMs ?? 3_600_000);
			tokens.set(token, { userId: user.id, expiresAt });
			return { accessToken: token, expiresAt: new Date(expiresAt).toISOString() };
		},
		async verifyToken(token) {
			if (!available) throw errors.unavailable("Authentication service is unavailable. Try again shortly.");
			const entry = tokens.get(token);
			if (!entry || entry.expiresAt < Date.now()) return null;
			const user = users.get(entry.userId);
			return user ? { id: user.id, email: user.email } : null;
		},
		async getUser(id) {
			const user = users.get(id);
			return user ? { id: user.id, email: user.email } : null;
		},
		async updateUser(id, changes) {
			const user = users.get(id);
			if (!user) throw errors.notFound();
			if (changes.email) user.email = changes.email;
			if (changes.password) user.password = changes.password;
		},
		async deleteUser(id) {
			users.delete(id);
		},
	};

	return {
		provider,
		users,
		setAvailable(value: boolean) {
			available = value;
		},
	};
}
