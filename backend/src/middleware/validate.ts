import type { z } from "zod";
import { errors } from "../lib/errors";

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
	const result = schema.safeParse(body ?? {});
	if (!result.success) {
		const issues = result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
		throw errors.badRequest(issues[0]?.message ?? "Invalid request body.", issues);
	}
	return result.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}
