import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });
dotenv.config({ path: path.join(__dirname, ".env.local"), override: true, quiet: true });

// Migrations use the direct (session) connection; the app runtime uses the pooled DATABASE_URL.
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
		seed: "tsx prisma/seed.ts",
	},
	datasource: {
		url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
	},
});
