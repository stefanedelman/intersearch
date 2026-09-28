import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import { serverEnv } from "./lib/env";
import { AppError } from "./lib/errors";
import { logger } from "./lib/logger";
import { requireAuth } from "./middleware/auth";
import { authRouter } from "./routes/auth.routes";
import { usersRouter } from "./routes/users.routes";
import { trackerRouter } from "./routes/tracker.routes";
import type { AuthProvider } from "./services/auth-provider";
import { createAuthService } from "./services/auth.service";

declare module "express-serve-static-core" {
	interface Request {
		requestId?: string;
	}
}

export function createApp(deps: { authProvider: AuthProvider }) {
	const env = serverEnv();
	const authService = createAuthService(deps.authProvider);
	const authenticate = requireAuth(deps.authProvider, authService);
	const app = express();

	app.disable("x-powered-by");

	const assignRequestId: RequestHandler = (req, res, next) => {
		req.requestId = randomUUID();
		res.setHeader("X-Request-Id", req.requestId);
		next();
	};
	app.use(assignRequestId);

	// The browser (localhost:5173) and API (localhost:3000) are different origins, so every
	// frontend request is cross-origin. Only exact allowlisted origins get CORS permission.
	// Requests with no Origin header (curl, the tracker CLI, the grading script) are not browser
	// requests and are unaffected by CORS.
	app.use(
		cors({
			origin: (origin, callback) => callback(null, !origin || env.CORS_ALLOWED_ORIGINS.includes(origin)),
			methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
			exposedHeaders: ["X-Request-Id"],
			maxAge: 600,
		}),
	);

	app.use(express.json({ limit: "1mb" }));

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok" });
	});

	app.use("/api/auth", authRouter(authService, authenticate));
	app.use("/api/users", usersRouter(authService, authenticate));
	app.use("/api/tracker", trackerRouter(authenticate));

	app.use((_req, res) => {
		res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
	});

	const handleError: ErrorRequestHandler = (error, req, res, _next) => {
		const requestId = req.requestId;
		if (error instanceof AppError) {
			res.status(error.status).json({
				error: { code: error.code, message: error.message, requestId, ...(error.details ? { details: error.details } : {}) },
			});
			return;
		}
		// body-parser errors: malformed JSON and oversized bodies.
		const status = typeof error?.status === "number" ? error.status : undefined;
		if (error?.type === "entity.parse.failed") {
			res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON.", requestId } });
			return;
		}
		if (error?.type === "entity.too.large" || status === 413) {
			res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large.", requestId } });
			return;
		}
		logger.error("Unhandled request error", { requestId, path: req.path, error: String(error?.stack ?? error) });
		res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong.", requestId } });
	};
	app.use(handleError);

	return app;
}
