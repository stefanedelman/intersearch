export class AppError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
	}
}

export const errors = {
	badRequest: (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details),
	unauthorized: (message = "Authentication required.") => new AppError(401, "UNAUTHORIZED", message),
	notFound: (message = "Not found.") => new AppError(404, "NOT_FOUND", message),
	conflict: (code: string, message: string) => new AppError(409, code, message),
	unavailable: (message: string) => new AppError(503, "SERVICE_UNAVAILABLE", message),
};
