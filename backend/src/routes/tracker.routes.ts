import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { startRunBodySchema } from "../contracts/tracker";
import { errors } from "../lib/errors";
import { authOf } from "../middleware/auth";
import { isUuid, parseBody } from "../middleware/validate";
import { trackerService } from "../services/tracker.service";
import type { JobRunner } from "../orchestrator/jobs";
import { claimLabels } from "../contracts/report";

const pageQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(500).optional(),
});

function page(req: Request, defaultLimit: number) {
	const query = pageQuery.safeParse(req.query);
	if (!query.success) throw errors.badRequest("Invalid pagination parameters.");
	if (query.data.cursor && !isUuid(query.data.cursor)) throw errors.badRequest("Invalid cursor.");
	return { cursor: query.data.cursor, limit: query.data.limit ?? defaultLimit };
}

/** Malformed ids are 404, like any id the caller does not own. */
function idParam(req: Request, name = "id") {
	const value = req.params[name];
	if (!isUuid(value)) throw errors.notFound("Not found.");
	return value;
}

export function trackerRouter(requireAuth: RequestHandler, runner: JobRunner) {
	const router = Router();
	router.use(requireAuth);

	router.get("/", async (req, res) => {
		res.json(await trackerService.getTracker(authOf(req).userId));
	});

	router.put("/config", async (req, res) => {
		const body = parseBody(z.object({ config: z.unknown() }), req.body);
		res.json(await trackerService.importConfig(authOf(req).userId, body.config));
	});

	router.get("/report/latest", async (req, res) => {
		res.json(await trackerService.latestReport(authOf(req).userId));
	});

	// 202: the run continues in the background; poll GET /runs/:id for phase and worker calls.
	router.post("/runs", async (req, res) => {
		const body = parseBody(startRunBodySchema, req.body);
		res.status(202).json(await trackerService.launchRun(authOf(req).userId, body.idempotencyKey, runner));
	});

	router.post("/runs/:id/cancel", async (req, res) => {
		res.status(202).json(await trackerService.cancelRun(authOf(req).userId, idParam(req), runner));
	});

	router.get("/runs/:id/claims", async (req, res) => {
		const query = z.object({ label: z.enum(claimLabels).optional() }).safeParse(req.query);
		if (!query.success) throw errors.badRequest(`label must be one of ${claimLabels.join(", ")}.`);
		res.json(await trackerService.listClaims(authOf(req).userId, idParam(req), query.data.label));
	});

	router.get("/workers", async (_req, res) => {
		res.json(await trackerService.workers(runner));
	});

	router.post("/workers/verifier/wake", async (req, res) => {
		res.json(await trackerService.wakeVerifier(authOf(req).userId, runner));
	});

	router.get("/runs", async (req, res) => {
		const { cursor, limit } = page(req, 20);
		res.json(await trackerService.listRuns(authOf(req).userId, cursor, limit));
	});

	router.get("/runs/:id", async (req, res) => {
		res.json(await trackerService.getRun(authOf(req).userId, idParam(req)));
	});

	router.get("/runs/:id/report", async (req, res) => {
		res.json(await trackerService.getReport(authOf(req).userId, idParam(req)));
	});

	router.get("/runs/:id/sources", async (req, res) => {
		const { cursor, limit } = page(req, 100);
		res.json(await trackerService.listSources(authOf(req).userId, idParam(req), cursor, limit));
	});

	router.get("/runs/:id/trace", async (req, res) => {
		const { cursor, limit } = page(req, 200);
		res.json(await trackerService.listTrace(authOf(req).userId, idParam(req), cursor, limit));
	});

	router.post("/reset", async (req, res) => {
		res.json(await trackerService.reset(authOf(req).userId, (req.body as { confirm?: unknown } | undefined)?.confirm));
	});

	return router;
}
