import { isAuthApiError, isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { AppError, errors } from "../lib/errors";

export type AuthUser = { id: string; email: string | null };
export type AuthSession = { accessToken: string; expiresAt: string };

// Everything the API needs from an identity provider. Routes and services depend on this
// interface, so tests can substitute an in-memory fake for Supabase Auth.
export interface AuthProvider {
	createUser(input: { email: string; password: string; username: string }): Promise<AuthUser>;
	/** Returns null for wrong credentials. */
	signIn(email: string, password: string): Promise<AuthSession | null>;
	/** Returns null for missing, invalid, expired, or deleted-user tokens. Throws 503 if unreachable. */
	verifyToken(token: string): Promise<AuthUser | null>;
	getUser(id: string): Promise<AuthUser | null>;
	updateUser(id: string, changes: { email?: string; password?: string }): Promise<void>;
	deleteUser(id: string): Promise<void>;
}

// Maps Supabase Auth errors to our API's status codes without leaking provider details.
export function toAppError(error: AuthError): AppError {
	if (isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500) {
		return errors.unavailable("Authentication service is unavailable. Try again shortly.");
	}
	if (isAuthApiError(error)) {
		switch (error.code) {
			case "email_exists":
			case "user_already_exists":
				return errors.conflict("EMAIL_TAKEN", "That email is already in use.");
			case "weak_password":
				return errors.badRequest("Password does not meet the password policy.");
			case "email_address_invalid":
			case "validation_failed":
				return errors.badRequest("Email address is not accepted.");
			case "over_request_rate_limit":
			case "over_email_send_rate_limit":
				return new AppError(429, "RATE_LIMITED", "Too many requests. Try again shortly.");
		}
	}
	return new AppError(500, "AUTH_PROVIDER_ERROR", "Authentication provider error.");
}
