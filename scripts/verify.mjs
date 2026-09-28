// A1 grading rehearsal: exercises every account endpoint against a running backend, the way the
// course's automated script does. Registers two throwaway accounts, checks shapes, status codes,
// and the three rules, then deletes both accounts.
//
//   npm run verify                      # against http://localhost:3000
//   API_URL=http://host:port npm run verify
const API = (process.env.API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const results = [];
const stamp = Date.now().toString(36);

async function call(method, path, { token, body } = {}) {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	return { status: response.status, json, text };
}

function check(name, condition, detail = "") {
	results.push({ name, ok: Boolean(condition), detail });
}

const HASH_LIKE = /\$2[aby]\$|\$argon2|\$scrypt|passwordhash|password_hash|encrypted_password|refresh_token/i;

async function main() {
	try {
		await fetch(`${API}/healthz`);
	} catch {
		console.error(`Cannot reach ${API}. Start the backend first: npm run dev:backend`);
		process.exit(2);
	}

	const health = await call("GET", "/healthz");
	check("GET /healthz returns 200 {status: ok}", health.status === 200 && JSON.stringify(health.json) === '{"status":"ok"}', health.text);

	const users = {};
	for (const name of ["a", "b"]) {
		const username = `verify_${name}_${stamp}`;
		const password = `Verify-${stamp}-pw`;
		const res = await call("POST", "/api/auth/register", { body: { username, password } });
		check(`POST /api/auth/register (${name}) returns 201 with user id`, res.status === 201 && res.json?.user?.id, `${res.status} ${res.text.slice(0, 200)}`);
		check(`register response has no password hash (${name})`, !HASH_LIKE.test(res.text) && !res.text.includes(password));
		const login = await call("POST", "/api/auth/login", { body: { username, password } });
		check(`POST /api/auth/login (${name}) returns 200 with token`, login.status === 200 && typeof login.json?.token === "string", `${login.status}`);
		check(`login response has no password hash (${name})`, !HASH_LIKE.test(login.text));
		users[name] = { id: res.json?.user?.id, token: login.json?.token, username, password };
	}

	const dup = await call("POST", "/api/auth/register", { body: { username: users.a.username.toUpperCase(), password: "whatever-123" } });
	check("duplicate username (different case) returns 409", dup.status === 409, `${dup.status}`);
	const badLogin = await call("POST", "/api/auth/login", { body: { username: users.a.username, password: "wrong-password" } });
	check("wrong password returns 401", badLogin.status === 401, `${badLogin.status}`);

	const me = await call("GET", "/api/auth/me", { token: users.a.token });
	check("GET /api/auth/me returns the logged-in user", me.status === 200 && me.json?.user?.id === users.a.id, `${me.status}`);

	// Rule 2: no token, bad token, expired/garbage token -> 401 on every protected route.
	for (const [method, path] of [
		["GET", "/api/auth/me"],
		["GET", `/api/users/${users.a.id}`],
		["PATCH", `/api/users/${users.a.id}`],
		["DELETE", `/api/users/${users.a.id}`],
	]) {
		const none = await call(method, path, { body: method === "PATCH" ? { email: "x@example.com" } : undefined });
		const bad = await call(method, path, { token: "not-a-real-token", body: method === "PATCH" ? { email: "x@example.com" } : undefined });
		const expired = await call(method, path, { token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl", body: method === "PATCH" ? { email: "x@example.com" } : undefined });
		check(`rule 2: ${method} ${path.replace(users.a.id, ":id")} without/with bad/expired token -> 401`, none.status === 401 && bad.status === 401 && expired.status === 401, `${none.status}/${bad.status}/${expired.status}`);
	}

	// Rule 3: A's token against B's id must be refused with the same code for GET, PATCH, DELETE.
	const crossGet = await call("GET", `/api/users/${users.b.id}`, { token: users.a.token });
	const crossPatch = await call("PATCH", `/api/users/${users.b.id}`, { token: users.a.token, body: { email: "hijack@example.com" } });
	const crossPatchInvalid = await call("PATCH", `/api/users/${users.b.id}`, { token: users.a.token, body: { password: "x" } });
	const crossDelete = await call("DELETE", `/api/users/${users.b.id}`, { token: users.a.token });
	const codes = [crossGet.status, crossPatch.status, crossPatchInvalid.status, crossDelete.status];
	check("rule 3: cross-user GET/PATCH/DELETE all refused with the same code (404)", codes.every((code) => code === 404), codes.join("/"));
	const bStill = await call("GET", `/api/users/${users.b.id}`, { token: users.b.token });
	check("rule 3: B's account is unchanged", bStill.status === 200 && bStill.json?.user?.email === null, bStill.text.slice(0, 200));

	// Own account lifecycle with ONE token, like the grading script.
	const get = await call("GET", `/api/users/${users.a.id}`, { token: users.a.token });
	check("GET own /api/users/:id returns 200", get.status === 200 && get.json?.user?.id === users.a.id, `${get.status}`);
	const newPassword = `${users.a.password}-new`;
	const patchPw = await call("PATCH", `/api/users/${users.a.id}`, { token: users.a.token, body: { password: newPassword } });
	check("PATCH own password returns 200 without a hash", patchPw.status === 200 && !HASH_LIKE.test(patchPw.text), `${patchPw.status}`);
	const afterPw = await call("GET", `/api/users/${users.a.id}`, { token: users.a.token });
	check("the same token still works after a password change", afterPw.status === 200, `${afterPw.status}`);
	const email = `verify_${stamp}@example.com`;
	const patchEmail = await call("PATCH", `/api/users/${users.a.id}`, { token: users.a.token, body: { email } });
	check("PATCH own email returns the updated user", patchEmail.status === 200 && patchEmail.json?.user?.email === email, patchEmail.text.slice(0, 200));
	const oldLogin = await call("POST", "/api/auth/login", { body: { username: users.a.username, password: users.a.password } });
	const newLogin = await call("POST", "/api/auth/login", { body: { username: users.a.username, password: newPassword } });
	check("old password rejected, new password accepted", oldLogin.status === 401 && newLogin.status === 200, `${oldLogin.status}/${newLogin.status}`);
	const emailLogin = await call("POST", "/api/auth/login", { body: { email, password: newPassword } });
	check("login by email works", emailLogin.status === 200, `${emailLogin.status}`);

	for (const name of ["a", "b"]) {
		const del = await call("DELETE", `/api/users/${users[name].id}`, { token: users[name].token });
		check(`DELETE own account (${name}) returns 200`, del.status === 200, `${del.status}`);
		const after = await call("GET", "/api/auth/me", { token: users[name].token });
		check(`deleted account's token returns 401 (${name})`, after.status === 401, `${after.status}`);
	}

	const unknown = await call("GET", "/api/definitely-not-a-route");
	check("unknown API route returns JSON 404", unknown.status === 404 && typeof unknown.json === "object", `${unknown.status}`);

	const width = Math.max(...results.map((result) => result.name.length));
	for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name.padEnd(width)}  ${result.ok ? "" : result.detail}`);
	const failed = results.filter((result) => !result.ok).length;
	console.log(`\n${results.length - failed}/${results.length} checks passed against ${API}`);
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
