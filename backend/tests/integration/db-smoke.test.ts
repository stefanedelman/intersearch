import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestDatabase } from "../helpers/test-db";

process.env.APP_ENV = "test";
process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

let stopDb: () => Promise<void>;

before(async () => {
	stopDb = (await startTestDatabase()).stop;
});

after(async () => {
	const { closePrisma } = await import("../../src/lib/prisma");
	await closePrisma();
	await stopDb();
});

test("migrations apply and profile deletion cascades to tracker data", async () => {
	const { prisma } = await import("../../src/lib/prisma");
	const id = randomUUID();
	await prisma.profile.create({
		data: { id, username: "Alice", normalizedUsername: "alice", tracker: { create: {} } },
	});
	const tracker = await prisma.tracker.findUniqueOrThrow({ where: { profileId: id } });
	await prisma.run.create({
		data: { trackerId: tracker.id, idempotencyKey: "k1", configSnapshot: {}, configHash: "h", comparisonKey: "c" },
	});
	await assert.rejects(
		prisma.profile.create({ data: { id: randomUUID(), username: "ALICE", normalizedUsername: "alice" } }),
	);
	await prisma.profile.delete({ where: { id } });
	assert.equal(await prisma.run.count(), 0);
	assert.equal(await prisma.tracker.count(), 0);
});
