import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import request from "supertest";
import { startTestDatabase } from "../helpers/test-db";
import { createFakeAuthProvider } from "../helpers/fake-auth-provider";

process.env.APP_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.CORS_ALLOWED_ORIGINS = "http://localhost:5173";

let app: Express;
let fake: ReturnType<typeof createFakeAuthProvider>;
let stopDb: () => Promise<void>;

before(async () => {
	stopDb = (await startTestDatabase()).stop;
	fake = createFakeAuthProvider();
	const { createApp } = await import("../../src/app");
	app = createApp({ authProvider: fake.provider });
});

after(async () => {
	const { closePrisma } = await import("../../src/lib/prisma");
	await closePrisma();
	await stopDb();
});

beforeEach(async () => {
	const { prisma } = await import("../../src/lib/prisma");
	await prisma.profile.deleteMany();
	fake.users.clear();
	fake.setAvailable(true);
});

const HASH_LIKE = /\$2[aby]\$|\$argon2|\$scrypt|passwordHash|encrypted_password|refresh_token/i;

function assertNoSecrets(body: unknown) {
	assert.doesNotMatch(JSON.stringify(body), HASH_LIKE);
}

async function register(username: string, password = "Courant2026!") {
	const res = await request(app).post("/api/auth/register").send({ username, password });
	assert.equal(res.status, 201, JSON.stringify(res.body));
	return { id: res.body.user.id as string, token: res.body.token as string, password };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("A1 endpoints", () => {
	test("healthz returns exactly {status: ok}", async () => {
		const res = await request(app).get("/healthz");
		assert.equal(res.status, 200);
		assert.deepEqual(res.body, { status: "ok" });
	});

	test("register accepts only username and password, and returns user and token", async () => {
		const res = await request(app).post("/api/auth/register").send({ username: "NYUgrader", password: "Courant2026!" });
		assert.equal(res.status, 201);
		assert.equal(res.body.user.username, "NYUgrader");
		assert.equal(res.body.user.email, null);
		assert.ok(res.body.token);
		assertNoSecrets(res.body);
	});

	test("register with email shows the email; duplicate usernames differing only in case are rejected", async () => {
		const first = await request(app)
			.post("/api/auth/register")
			.send({ username: "alice", password: "secret123", email: "Alice@Example.com" });
		assert.equal(first.status, 201);
		assert.equal(first.body.user.email, "alice@example.com");
		const dup = await request(app).post("/api/auth/register").send({ username: "ALICE", password: "secret123" });
		assert.equal(dup.status, 409);
		assert.equal(fake.users.size, 1, "a rejected registration must not leave an orphan auth user");
	});

	test("register validates input with 400", async () => {
		const res = await request(app).post("/api/auth/register").send({ username: "x", password: "1" });
		assert.equal(res.status, 400);
		const bad = await request(app).post("/api/auth/register").set("Content-Type", "application/json").send("{oops");
		assert.equal(bad.status, 400);
	});

	test("login by username (any case) or email returns a token; wrong password is 401", async () => {
		await request(app).post("/api/auth/register").send({ username: "Bob", password: "secret123", email: "bob@example.com" });
		const byName = await request(app).post("/api/auth/login").send({ username: "bob", password: "secret123" });
		assert.equal(byName.status, 200);
		assert.ok(byName.body.token);
		assert.equal(byName.body.user.username, "Bob");
		assertNoSecrets(byName.body);
		const byEmail = await request(app).post("/api/auth/login").send({ email: "bob@example.com", password: "secret123" });
		assert.equal(byEmail.status, 200);
		const wrong = await request(app).post("/api/auth/login").send({ username: "bob", password: "nope123" });
		assert.equal(wrong.status, 401);
		const unknown = await request(app).post("/api/auth/login").send({ username: "nobody", password: "secret123" });
		assert.equal(unknown.status, 401);
		assert.equal(wrong.body.error.message, unknown.body.error.message, "no user enumeration via login errors");
	});

	test("rule 2: missing, malformed, and unknown tokens are 401 on every protected route", async () => {
		const a = await register("alice");
		for (const [method, path] of [
			["get", "/api/auth/me"],
			["get", `/api/users/${a.id}`],
			["patch", `/api/users/${a.id}`],
			["delete", `/api/users/${a.id}`],
		] as const) {
			assert.equal((await request(app)[method](path)).status, 401, `${method} ${path} without token`);
			assert.equal((await request(app)[method](path).set("Authorization", "Bearer garbage")).status, 401);
			assert.equal((await request(app)[method](path).set("Authorization", a.token)).status, 401, "no Bearer prefix");
		}
	});

	test("rule 3: another user's id is 404 for GET, PATCH, and DELETE, before body validation", async () => {
		const a = await register("alice");
		const b = await register("bobby");
		const get = await request(app).get(`/api/users/${b.id}`).set(bearer(a.token));
		const patch = await request(app).patch(`/api/users/${b.id}`).set(bearer(a.token)).send({ password: "x" });
		const patchValid = await request(app).patch(`/api/users/${b.id}`).set(bearer(a.token)).send({ email: "hijack@example.com" });
		const del = await request(app).delete(`/api/users/${b.id}`).set(bearer(a.token));
		for (const res of [get, patch, patchValid, del]) assert.equal(res.status, 404);
		for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
			assert.equal((await request(app).get(`/api/users/${id}`).set(bearer(a.token))).status, 404);
		}
		const stillThere = await request(app).get(`/api/users/${b.id}`).set(bearer(b.token));
		assert.equal(stillThere.status, 200);
		assert.equal(stillThere.body.user.email, null, "B was not modified");
	});

	test("grading-script sequence works with one token: me, get, patch password, get, patch email, delete", async () => {
		const a = await register("alice", "secret123");
		const me = await request(app).get("/api/auth/me").set(bearer(a.token));
		assert.equal(me.status, 200);
		assert.equal(me.body.user.id, a.id);
		assert.equal((await request(app).get(`/api/users/${a.id}`).set(bearer(a.token))).status, 200);

		const pw = await request(app).patch(`/api/users/${a.id}`).set(bearer(a.token)).send({ password: "newsecret456" });
		assert.equal(pw.status, 200);
		assertNoSecrets(pw.body);
		assert.equal((await request(app).get(`/api/users/${a.id}`).set(bearer(a.token))).status, 200, "token survives password change");

		const email = await request(app).patch(`/api/users/${a.id}`).set(bearer(a.token)).send({ email: "alice@example.com" });
		assert.equal(email.status, 200);
		assert.equal(email.body.user.email, "alice@example.com");

		const renamed = await request(app).patch(`/api/users/${a.id}`).set(bearer(a.token)).send({ username: "alice2" });
		assert.equal(renamed.body.user.username, "alice2");

		assert.equal((await request(app).post("/api/auth/login").send({ username: "alice2", password: "secret123" })).status, 401);
		assert.equal((await request(app).post("/api/auth/login").send({ username: "alice2", password: "newsecret456" })).status, 200);

		const bad = await request(app).patch(`/api/users/${a.id}`).set(bearer(a.token)).send({});
		assert.equal(bad.status, 400, "own account with empty body is a validation error");

		const del = await request(app).delete(`/api/users/${a.id}`).set(bearer(a.token));
		assert.equal(del.status, 200);
		assert.equal((await request(app).get("/api/auth/me").set(bearer(a.token))).status, 401, "deleted user's token is 401");
		assert.equal(fake.users.size, 0, "auth user deleted too");
	});

	test("unreachable auth provider is 503, not 401 or 200", async () => {
		const a = await register("alice");
		fake.setAvailable(false);
		assert.equal((await request(app).get("/api/auth/me").set(bearer(a.token))).status, 503);
	});

	test("unknown routes return JSON 404", async () => {
		const res = await request(app).get("/api/does-not-exist");
		assert.equal(res.status, 404);
		assert.equal(res.body.error.code, "NOT_FOUND");
	});

	test("CORS allows the frontend origin with Authorization and refuses others", async () => {
		const ok = await request(app)
			.options("/api/auth/me")
			.set("Origin", "http://localhost:5173")
			.set("Access-Control-Request-Method", "GET")
			.set("Access-Control-Request-Headers", "authorization");
		assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
		assert.match(String(ok.headers["access-control-allow-headers"]), /authorization/i);
		const evil = await request(app)
			.options("/api/auth/me")
			.set("Origin", "https://evil.example")
			.set("Access-Control-Request-Method", "GET");
		assert.equal(evil.headers["access-control-allow-origin"], undefined);
	});
});
