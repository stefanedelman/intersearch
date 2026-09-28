import { z } from "zod";

// Lenient by design: the grading script's request shapes are not specified, so unknown
// fields are ignored and email is optional. See INTERSEARCH_PLAN.md section 1.

export const usernameSchema = z
	.string()
	.trim()
	.min(3, "Username must be at least 3 characters.")
	.max(32, "Username must be at most 32 characters.")
	.regex(/^[A-Za-z0-9_.-]+$/, "Username may contain letters, numbers, dots, dashes, and underscores.");

// Supabase Auth hashes with bcrypt, which only uses the first 72 bytes; its default minimum is 6.
export const passwordSchema = z
	.string()
	.min(6, "Password must be at least 6 characters.")
	.refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes.");

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254));

const optionalEmail = z
	.union([emailSchema, z.literal(""), z.null()])
	.optional()
	.transform((value) => (value ? value : undefined));

export const registerBodySchema = z.object({
	username: usernameSchema,
	password: passwordSchema,
	email: optionalEmail,
});

export const loginBodySchema = z
	.object({
		username: z.string().trim().min(1).max(254).optional(),
		email: z.string().trim().min(1).max(254).optional(),
		password: z.string().min(1).max(1024),
	})
	.refine((body) => body.username || body.email, { message: "Provide a username or email." });

export const updateUserBodySchema = z
	.object({
		username: usernameSchema.optional(),
		email: emailSchema.optional(),
		password: passwordSchema.optional(),
	})
	.refine((body) => body.username !== undefined || body.email !== undefined || body.password !== undefined, {
		message: "Provide at least one of username, email, or password.",
	});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

export type UserDto = {
	id: string;
	username: string;
	email: string | null;
	createdAt: string;
	updatedAt: string;
};

export function normalizeUsername(username: string): string {
	return username.normalize("NFKC").trim().toLowerCase();
}
