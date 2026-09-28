import { Router } from "express";
import { loginBodySchema, registerBodySchema } from "../contracts/auth";
import { authOf } from "../middleware/auth";
import { parseBody } from "../middleware/validate";
import type { AuthService } from "../services/auth.service";
import type { RequestHandler } from "express";

export function authRouter(authService: AuthService, requireAuth: RequestHandler) {
	const router = Router();

	router.post("/register", async (req, res) => {
		const result = await authService.register(parseBody(registerBodySchema, req.body));
		res.status(201).json(result);
	});

	router.post("/login", async (req, res) => {
		res.json(await authService.login(parseBody(loginBodySchema, req.body)));
	});

	router.get("/me", requireAuth, async (req, res) => {
		res.json({ user: await authService.getUser(authOf(req).userId) });
	});

	return router;
}
