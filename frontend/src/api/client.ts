const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

type Hooks = {
	getToken: () => string | null;
	onUnauthorized: () => void;
};

let hooks: Hooks = { getToken: () => null, onUnauthorized: () => undefined };

export function configureApi(next: Hooks) {
	hooks = next;
}

type RequestOptions = {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	body?: unknown;
	auth?: boolean;
	signal?: AbortSignal;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const { method = "GET", body, auth = true, signal } = options;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const token = auth ? hooks.getToken() : null;
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetch(`${BASE_URL}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		throw new ApiError(0, "NETWORK", "Cannot reach the Intersearch API. Is the backend running on port 3000?");
	}

	const payload = response.status === 204 ? null : await response.json().catch(() => null);
	if (!response.ok) {
		if (response.status === 401 && auth && token) hooks.onUnauthorized();
		const error = payload?.error;
		throw new ApiError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? `Request failed (${response.status}).`);
	}
	return payload as T;
}
