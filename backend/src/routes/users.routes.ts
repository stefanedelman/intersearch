import { Router, type Request, type RequestHandler } from "express";
import { updateUserBodySchema } from "../contracts/auth";
import { errors } from "../lib/errors";
import { authOf } from "../middleware/auth";
import { isUuid, parseBody } from "../middleware/validate";
import type { AuthService } from "../services/auth.service";

// Rule 3: a user can only touch their own account. Any other id (someone else's, nonexistent,
// or malformed) gets the same 404, so the API never confirms another account exists.
// Order matters: authenticate (401) -> ownership (404) -> body validation (400).
function ownAccount(req: Request) {
	const auth = authOf(req);
	const id = req.params.id;
	if (!isUuid(id) || id.toLowerCase() !== auth.userId.toLowerCase()) throw errors.notFound("User not found.");
	return auth;
}

export function usersRouter(authService: AuthService, requireAuth: RequestHandler) {
	const router = Router();
	router.use(requireAuth);

	router.get("/:id", async (req, res) => {
		const { userId } = ownAccount(req);
		res.json({ user: await authService.getUser(userId) });
	});

	router.patch("/:id", async (req, res) => {
		const { userId } = ownAccount(req);
		const body = parseBody(updateUserBodySchema, req.body);
		res.json({ user: await authService.updateUser(userId, body) });
	});

	router.delete("/:id", async (req, res) => {
		const { userId } = ownAccount(req);
		await authService.deleteUser(userId);
		res.json({ ok: true });
	});

	return router;
}
