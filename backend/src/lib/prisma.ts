import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { serverEnv } from "./env";

const pool = new pg.Pool({
	connectionString: serverEnv().DATABASE_URL,
	max: Number(process.env.DATABASE_POOL_MAX ?? 3),
	idleTimeoutMillis: 20000,
	connectionTimeoutMillis: 10000,
});

pool.on("error", (err) => {
	console.error("Idle pool client error (non-fatal):", err.message);
});

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

export async function closePrisma() {
	await prisma.$disconnect();
	await pool.end().catch(() => undefined);
}
