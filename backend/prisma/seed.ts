// Idempotently creates the course grader account (NYUgrader / Courant2026!) and its empty tracker.
// These are course-supplied test credentials for the throwaway course Supabase project only.
import { serverEnv } from "../src/lib/env";
import { closePrisma, prisma } from "../src/lib/prisma";
import { supabase } from "../src/lib/supabase";
import { normalizeUsername } from "../src/contracts/auth";

const GRADER_USERNAME = "NYUgrader";
const GRADER_PASSWORD = "Courant2026!";

async function main() {
	const env = serverEnv();
	if (env.APP_ENV === "production") throw new Error("Refusing to seed the grader account when APP_ENV=production.");

	const graderEmail = `nyugrader@${env.AUTH_PLACEHOLDER_EMAIL_DOMAIN}`;
	const normalizedUsername = normalizeUsername(GRADER_USERNAME);
	const existing = await prisma.profile.findUnique({ where: { normalizedUsername } });

	let userId: string;
	if (existing) {
		userId = existing.id;
		const { error } = await supabase.auth.admin.updateUserById(userId, { password: GRADER_PASSWORD });
		if (error) throw new Error(`Could not reset grader password: ${error.message}`);
		console.log(`Grader account exists (${userId}); password reset to the course value.`);
	} else {
		const { data, error } = await supabase.auth.admin.createUser({
			email: graderEmail,
			password: GRADER_PASSWORD,
			email_confirm: true,
			user_metadata: { username: GRADER_USERNAME },
		});
		if (error || !data.user) throw new Error(`Could not create grader auth user: ${error?.message}`);
		userId = data.user.id;
		await prisma.profile.create({
			data: { id: userId, username: GRADER_USERNAME, normalizedUsername, hasRealEmail: false },
		});
		console.log(`Created grader account ${GRADER_USERNAME} (${userId}).`);
	}

	await prisma.tracker.upsert({ where: { profileId: userId }, create: { profileId: userId }, update: {} });
	console.log("Grader tracker ready.");
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	})
	.finally(closePrisma);
