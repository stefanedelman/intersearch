import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { serverEnv } from "../lib/env";
import { errors } from "../lib/errors";
import { Prisma } from "../generated/prisma/client";
import type { Profile } from "../generated/prisma/client";
import {
	normalizeUsername,
	type LoginBody,
	type RegisterBody,
	type UpdateUserBody,
	type UserDto,
} from "../contracts/auth";
import type { AuthProvider } from "./auth-provider";

const invalidCredentials = () => errors.unauthorized("Invalid username or password.");

// Supabase Auth requires an email. Accounts registered without one get an undeliverable
// placeholder that is never shown and never emailed.
function placeholderEmail(): string {
	return `u-${randomUUID()}@${serverEnv().AUTH_PLACEHOLDER_EMAIL_DOMAIN}`;
}

function toUserDto(profile: Profile, authEmail: string | null): UserDto {
	return {
		id: profile.id,
		username: profile.username,
		email: profile.hasRealEmail ? authEmail : null,
		createdAt: profile.createdAt.toISOString(),
		updatedAt: profile.updatedAt.toISOString(),
	};
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createAuthService(provider: AuthProvider) {
	async function requireProfile(id: string): Promise<Profile> {
		const profile = await prisma.profile.findUnique({ where: { id } });
		if (!profile) throw errors.notFound("User not found.");
		return profile;
	}

	async function signInOrFail(email: string, password: string) {
		const session = await provider.signIn(email, password);
		if (!session) throw invalidCredentials();
		return session;
	}

	return {
		async register(body: RegisterBody) {
			const normalizedUsername = normalizeUsername(body.username);
			if (await prisma.profile.findUnique({ where: { normalizedUsername } })) {
				throw errors.conflict("USERNAME_TAKEN", "That username is already taken.");
			}

			const email = body.email ?? placeholderEmail();
			const authUser = await provider.createUser({ email, password: body.password, username: body.username });

			let profile: Profile;
			try {
				profile = await prisma.profile.create({
					data: {
						id: authUser.id,
						username: body.username,
						normalizedUsername,
						hasRealEmail: body.email !== undefined,
						tracker: { create: {} },
					},
				});
			} catch (error) {
				// Keep Supabase Auth and Profile consistent: no orphan auth users.
				await provider.deleteUser(authUser.id).catch(() => undefined);
				if (isUniqueViolation(error)) throw errors.conflict("USERNAME_TAKEN", "That username is already taken.");
				throw error;
			}

			const session = await signInOrFail(email, body.password);
			return { user: toUserDto(profile, email), token: session.accessToken, expiresAt: session.expiresAt };
		},

		async login(body: LoginBody) {
			const identifier = (body.username ?? body.email ?? "").trim();
			let email: string;
			let profileId: string | undefined;

			if (identifier.includes("@")) {
				email = identifier.toLowerCase();
			} else {
				const profile = await prisma.profile.findUnique({
					where: { normalizedUsername: normalizeUsername(identifier) },
				});
				if (!profile) throw invalidCredentials();
				const authUser = await provider.getUser(profile.id);
				if (!authUser?.email) throw invalidCredentials();
				email = authUser.email;
				profileId = profile.id;
			}

			const session = await signInOrFail(email, body.password);
			if (!profileId) {
				const authUser = await provider.verifyToken(session.accessToken);
				if (!authUser) throw invalidCredentials();
				profileId = authUser.id;
			}
			const profile = await prisma.profile.findUnique({ where: { id: profileId } });
			if (!profile) throw invalidCredentials();
			return { token: session.accessToken, expiresAt: session.expiresAt, user: toUserDto(profile, email) };
		},

		async getUser(id: string, authEmail: string | null) {
			return toUserDto(await requireProfile(id), authEmail);
		},

		async updateUser(id: string, authEmail: string | null, body: UpdateUserBody) {
			const profile = await requireProfile(id);
			const normalizedUsername = body.username ? normalizeUsername(body.username) : undefined;

			if (normalizedUsername && normalizedUsername !== profile.normalizedUsername) {
				const taken = await prisma.profile.findUnique({ where: { normalizedUsername } });
				if (taken) throw errors.conflict("USERNAME_TAKEN", "That username is already taken.");
			}

			if (body.email !== undefined || body.password !== undefined) {
				await provider.updateUser(id, { email: body.email, password: body.password });
			}

			try {
				const updated = await prisma.profile.update({
					where: { id },
					data: {
						...(body.username ? { username: body.username, normalizedUsername } : {}),
						...(body.email ? { hasRealEmail: true } : {}),
						// Touch updatedAt even for credential-only changes.
						updatedAt: new Date(),
					},
				});
				return toUserDto(updated, body.email ?? authEmail);
			} catch (error) {
				if (isUniqueViolation(error)) throw errors.conflict("USERNAME_TAKEN", "That username is already taken.");
				throw error;
			}
		},

		async deleteUser(id: string) {
			// Our rows first (cascades tracker history), then the Supabase Auth user.
			await prisma.profile.deleteMany({ where: { id } });
			await provider.deleteUser(id);
		},

		/** For the auth middleware: the Supabase user must also have a profile. */
		async hasProfile(id: string) {
			return (await prisma.profile.count({ where: { id } })) > 0;
		},
	};
}

export type AuthService = ReturnType<typeof createAuthService>;
