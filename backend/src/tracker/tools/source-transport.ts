import type { TransportOptions } from "../fetch/transport";
import type { ToolContext } from "./context";

/** The shared hooks apply to article requests AND job feeds, including every redirect hop. */
export function sourceTransport(ctx: ToolContext, tool: string, args: Record<string, unknown>): TransportOptions {
	return {
		beforeRequest: () => ctx.budget.reserveNetwork(),
		onRoundTrip: (trip) => ctx.trace.record({
			category: "http",
			service: new URL(trip.url).hostname,
			tool,
			step: ctx.step,
			parentEventId: ctx.parentEventId,
			arguments: { ...args, url: trip.url },
			startedAt: trip.startedAt,
			latencyMs: trip.latencyMs,
			status: typeof trip.status === "number" && trip.status < 400 && !trip.errorCode ? "ok" : "error",
			errorCode: trip.errorCode,
			detail: { httpStatus: trip.status, redirectHop: trip.redirectHop },
		}),
	};
}
