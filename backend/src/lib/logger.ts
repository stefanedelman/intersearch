import { redact, redactString } from "../shared/redact";

type Level = "info" | "warn" | "error";

function write(level: Level, message: string, fields?: Record<string, unknown>) {
	if (process.env.APP_ENV === "test" && level === "info") return;
	const line = JSON.stringify({ level, time: new Date().toISOString(), message: redactString(message), ...(redact(fields ?? {}) as object) });
	(level === "error" ? console.error : console.log)(line);
}

export const logger = {
	info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
	warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
	error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
