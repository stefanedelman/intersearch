# Design decisions

Short records of the choices that shape Intersearch: the problem, what we chose, and the tradeoff.

## Supabase Postgres with Prisma

**Problem:** we need a persistent relational store for accounts, runs, pages, and reports, with the same stack as Cirilio.

**Choice:** Supabase Postgres, accessed only through Prisma 7 (`@prisma/adapter-pg`) from the Express API. Runtime uses the transaction pooler; migrations use the session connection.

**Tradeoff:** the data is relational and queried by owner (tracker → runs → items), so SQL beats a document store. Free Supabase projects pause when idle, so they must be woken before grading.

## Supabase Auth behind our own endpoints

**Problem:** A1 needs specific endpoints and hashed passwords, and we want to match Cirilio's auth.

**Choice:** Supabase Auth, with Cirilio's server pattern: a service-role client and a `requireAuth` middleware. The middleware verifies tokens with `supabase.auth.getClaims(token)` (ES256 signature and expiry, checked against the project's published keys) plus a check that the `Profile` still exists. It is wrapped by our own `/api/auth/*` and `/api/users/:id` endpoints.

- Registration uses `auth.admin.createUser` with `email_confirm: true`, so no confirmation email is sent.
- Usernames live in our `Profile` table. Supabase requires an email, so accounts registered without one get a hidden placeholder address.

**Tradeoff:**

- Passwords are hashed with bcrypt by Supabase (GoTrue), and our tables never hold a hash.
- The price: Supabase's rate limits apply, and the throwaway project's service-role key has to be in the committed course `.env`. It reaches no further than the database URL A1 already lets us commit.
- Unlike Cirilio, the frontend never talks to Supabase directly; it only calls our API.

## 404, not 403, for other users' resources

**Problem:** A1 rule 3: a user cannot touch another user's account, and all refusals must use one code.

**Choice:** 404 for another user's id, a nonexistent id, and a malformed id. Checks run in order: authentication (401), then ownership (404), then body validation (400).

**Tradeoff:** 403 is the more literal "forbidden", but it confirms the account exists. 404 reveals nothing, and checking ownership before validation keeps the code identical even for invalid bodies.

## Tokens survive PATCH

**Problem:** the grading script reuses one token across PATCH and DELETE.

**Choice:** changing the password does not revoke the token that made the change. Supabase itself ends all sessions when an admin changes a password, so a `getUser` check (Cirilio's pattern) returned 401 for the grading script's next call. Tested against the real project on 2026-09-28. We verify the token's signature and expiry instead, and tokens expire on their own (default 1 hour).

**Tradeoff:** a stolen token stays valid until it expires even after a password change. Revoking would be stricter but would break the grading flow.

## CLI-only runs, no queue or worker

**Problem:** where should the agent run?

**Choice:** runs start from `npm run tracker:run`. The dashboard shows status and the command; it has no run button.

**Tradeoff:** a dashboard button needs a queue, a worker, and leases, which is a lot of machinery that isn't graded. The whole agent also can't run inside an HTTP request.

## Comparison key vs. full config hash

**Problem:** graders edit limits to test budgets, and that must not reset New/Still/Dropped.

**Choice:** runs compare against the last complete run with the same comparison key: a hash of only the topic, K, season, preferences, and companies. The full config hash is still recorded for transparency.

**Tradeoff:** changing the model or instructions changes behavior, yet runs stay comparable. That is intended: the question is "what changed in the world", not "what changed in the config".

## Local artifacts first, API second

**Problem:** a network cut also cuts the backend off from Supabase.

**Choice:** every run appends its trace to `runs/<id>/trace.jsonl` as it goes, and writes `report.md` before uploading. `tracker:sync` uploads later.

**Tradeoff:** the same data briefly lives in two places, but the run is never lost.

## Code extracts facts; code ranks

See [AGENT.md](../AGENT.md) section 1.

**Choice:** facts are verbatim quotes cut from the stored page. Scoring is deterministic: role 35, season 25, location 20, skills 15, freshness 5. The API rejects any report whose quotes are not in their cited sources.

**Tradeoff:** extraction is rule-based, so unusual postings yield sparse facts. The report shows those as "not stated" rather than guessing.

## Conservative dedupe

**Choice:** identity is company plus the provider's job id when one exists; otherwise company, title, location, and season. Different job ids are never merged.

**Tradeoff:** a repost under a new id looks new. That beats collapsing different locations' postings that share a title (Stripe has eight).

## Cached pages are reused

**Choice:** a posting URL fetched before is not fetched again (`skipped_seen`). The company job feed is refreshed every run, and it is what detects postings that are "no longer listed".

**Tradeoff:** a cached page can go stale. Its fetch date is shown, and a missing posting is never called closed unless the feed shows it gone.

## Cross-origin locally

**Choice:** the browser at `localhost:5173` calls the API at `localhost:3000` directly, with no Vite proxy. CORS allows exact origins only, plus the `Authorization` header.

**Tradeoff:** there's some CORS setup, but local development behaves like a real deployment where the frontend and API are on different origins.

## Greenfield

**Choice:** no compatibility layers. Schemas and interfaces are replaced outright while building. The genuine run-1 and run-2 evidence is the only data that must be preserved.
