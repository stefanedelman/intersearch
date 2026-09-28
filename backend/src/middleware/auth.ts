import type { NextFunction, Request, Response } from "express";
import { errors } from "../lib/errors";
import type { AuthProvider } from "../services/auth-provider";
import type { AuthService } from "../services/auth.service";

declare module "express-serve-static-core" {
	interface Request {
		auth?: { userId: string; email: string | null };
	}
}

// Mirrors Cirilio's requireAuth: the bearer token is a Supabase access token checked with getUser.
// Missing, invalid, expired, and deleted-user tokens are all 401; an unreachable Supabase is 503.
export function requireAuth(provider: AuthProvider, authService: AuthService) {
	return async (req: Request, _res: Response, next: NextFunction) => {
		const header = req.headers.authorization;
		const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
		if (!match?.[1]) throw errors.unauthorized("Missing bearer token.");

		const user = await provider.verifyToken(match[1]);
		if (!user || !(await authService.hasProfile(user.id))) throw errors.unauthorized("Invalid or expired token.");

		req.auth = { userId: user.id, email: user.email };
		next();
	};
}

export function authOf(req: Request) {
	if (!req.auth) throw errors.unauthorized();
	return req.auth;
}
