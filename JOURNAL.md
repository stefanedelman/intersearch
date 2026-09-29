# Assignment journal

**What I built and why this stack.** Intersearch is a dashboard for tracking internships at five companies (subject to change) I'd apply to. I matched the stack I already use in Cirilio: Vue 3 and Vite on the front, Express 5 and Prisma on the back, Supabase for Postgres and auth. That way my effort went into the system design rather than learning new tools.

**Security decisions.** Supabase Auth hashes passwords with bcrypt, so my own tables never hold a hash. Every account endpoint checks the token, then ownership, then the input, in that order. For someone else's account I return 404 instead of 403, so the API never confirms an account exists.

**The network part.** The frontend (localhost:5173) and API (localhost:3000) are different origins, so every request is cross-origin. The preflight has to allow the `Authorization` header.

**Challenges.**
- Supabase Auth logs in by email, but the grader account is a username, so I added a `Profile` table that maps usernames to auth users.
- The grading script reuses one token after changing the password, so password changes must not revoke that token.
- Real job boards returned JSON with raw control characters, and dollar amounts like "$124 trillion of assets" looked like pay until I tightened the rules.


