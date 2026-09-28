import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// In-memory Postgres (PGlite) served over the wire protocol, so the real pg + Prisma code path
// runs in tests without Docker or a hosted database. PGlite has one session, so the pool is 1.
export async function startTestDatabase() {
	const db = await PGlite.create();
	const migrationsDir = path.join(__dirname, "../../prisma/migrations");
	for (const dir of fs.readdirSync(migrationsDir).filter((name) => /^\d+_/.test(name)).sort()) {
		await db.exec(fs.readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8"));
	}
	const port = 55000 + Math.floor(Math.random() * 5000);
	const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 4 });
	await server.start();
	process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
	process.env.DATABASE_POOL_MAX = "1";
	return {
		async stop() {
			await server.stop();
			await db.close();
		},
	};
}
