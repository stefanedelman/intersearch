import { api } from "./client";

export type User = {
	id: string;
	username: string;
	email: string | null;
	createdAt: string;
	updatedAt: string;
};

export type Session = { token: string; expiresAt: string; user: User };

export const authApi = {
	register: (body: { username: string; password: string; email?: string }) =>
		api<Session>("/api/auth/register", { method: "POST", body, auth: false }),
	login: (body: { username: string; password: string }) =>
		api<Session>("/api/auth/login", { method: "POST", body, auth: false }),
	me: () => api<{ user: User }>("/api/auth/me"),
	updateUser: (id: string, body: { email?: string; password?: string; username?: string }) =>
		api<{ user: User }>(`/api/users/${encodeURIComponent(id)}`, { method: "PATCH", body }),
	deleteUser: (id: string) => api<{ ok: true }>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
