import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { checkpointBodySchema, finalizeBodySchema, startRunBodySchema } from "../contracts/tracker";
import { errors } from "../lib/errors";
import { authOf } from "../middleware/auth";
import { isUuid, parseBody } from "../middleware/validate";
import { trackerService } from "../services/tracker.service";

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

export function trackerRouter(requireAuth: RequestHandler) {
	const router = Router();
	router.use(requireAuth);

	router.get("/", async (req, res) => {
		res.json(await trackerService.getTracker(authOf(req).userId));
	});

	router.put("/config", async (req, res) => {
		const body = parseBody(z.object({ config: z.unknown() }), req.body);
		res.json(await trackerService.importConfig(authOf(req).userId, body.config));
	});

	router.get("/state", async (req, res) => {
		const runId = typeof req.query.runId === "string" && isUuid(req.query.runId) ? req.query.runId : undefined;
		res.json(await trackerService.state(authOf(req).userId, runId));
	});

	router.get("/documents/:id", async (req, res) => {
		res.json(await trackerService.document(authOf(req).userId, idParam(req)));
	});

	router.get("/report/latest", async (req, res) => {
		res.json(await trackerService.latestReport(authOf(req).userId));
	});

	router.post("/runs", async (req, res) => {
		const body = parseBody(startRunBodySchema, req.body);
		res.status(201).json(await trackerService.startRun(authOf(req).userId, body.idempotencyKey));
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

	router.post("/runs/:id/checkpoint", async (req, res) => {
		const runId = idParam(req);
		res.json(await trackerService.checkpoint(authOf(req).userId, runId, parseBody(checkpointBodySchema, req.body)));
	});

	router.post("/runs/:id/finalize", async (req, res) => {
		const runId = idParam(req);
		res.json(await trackerService.finalize(authOf(req).userId, runId, parseBody(finalizeBodySchema, req.body)));
	});

	router.post("/reset", async (req, res) => {
		res.json(await trackerService.reset(authOf(req).userId, (req.body as { confirm?: unknown } | undefined)?.confirm));
	});

	return router;
}
