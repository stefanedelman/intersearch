# Assignment journal (draft notes — rewrite in your own voice before submitting)

> These are factual notes from the build, not a finished entry. The course asks for about half a page, single spaced, about your own experience. Replace the bracketed parts with what actually happened to you, and cut anything that isn't true for you.

**What I built and why this stack.** Intersearch is a dashboard for tracking internships at five companies I'd apply to. I matched the stack I already use in Cirilio: Vue 3 and Vite on the front, Express 5 and Prisma on the back, Supabase for Postgres and auth. That way my effort went into the system design rather than learning new tools. [Say why this project matters to you.]

**Security decisions.** Supabase Auth hashes passwords with bcrypt, so my own tables never hold a hash. Every account endpoint checks the token, then ownership, then the input, in that order. For someone else's account I return 404 instead of 403, so the API never confirms an account exists. [Add what surprised you here.]

**The network part.** The frontend (localhost:5173) and API (localhost:3000) are different origins, so every request is cross-origin. The preflight has to allow the `Authorization` header. [Describe the first CORS error you hit and how you fixed it.]

**Challenges.**
- Supabase Auth logs in by email, but the grader account is a username, so I added a `Profile` table that maps usernames to auth users.
- The grading script reuses one token after changing the password, so password changes must not revoke that token.
- Real job boards returned JSON with raw control characters, and dollar amounts like "$124 trillion of assets" looked like pay until I tightened the rules.
- [Add or remove based on your experience.]

**Tradeoffs.** I kept the tracker on the command line instead of adding a dashboard "Run" button, which would have needed a queue, a worker, and leases. [One sentence on whether you agree with that in hindsight.]

**What I learned / enjoyed.** [Your own words.]
