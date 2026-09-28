// Keys whose values must never reach logs, traces, or exports. Matched as whole key names, so
// counters such as inputTokens or contentHash are kept.
const SENSITIVE_KEY =
	/^(password|passwd|pass|new_?password|current_?password|secret|client_?secret|jwt_?secret|token|access_?token|refresh_?token|id_?token|bearer|authorization|cookie|set-cookie|session|api_?key|apikey|x-api-key|password_?hash|encrypted_password|database_url|direct_url|service_role_key|supabase_service_role_key|groq_api_key|tavily_api_key)$/i;

// Values that look like credentials even when stored under an innocent key.
const SENSITIVE_VALUE = [
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
	/\b(gsk|tvly|sk|sb_secret|sb_publishable)[-_][A-Za-z0-9_-]{8,}/g, // provider keys
	/postgres(ql)?:\/\/[^\s"']+/g, // connection strings
	/Bearer\s+[A-Za-z0-9._-]+/gi,
];

export function redactString(value: string): string {
	return SENSITIVE_VALUE.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

export function redact(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[TRUNCATED]";
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(inner, depth + 1);
		}
		return out;
	}
	return value;
}

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
