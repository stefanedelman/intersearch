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

**Tradeoff:** the same data briefly lives in two places. After the server returns a run id, even a failure loading previous state produces a local partial report; it explicitly says comparison is unavailable and makes no provider request. Failures before run creation still fail fast.

## Code extracts facts; code ranks

See [AGENT.md](../AGENT.md) section 1.

**Choice:** facts are verbatim quotes cut from the stored page. Scoring is deterministic: role 35, season 25, location 20, skills 15, freshness 5. The API rejects any report whose quotes are not in their cited sources. The model can select a source quote but cannot add a free-form factual note: a matching quote alone does not establish that an accompanying claim is true.

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

## Budget reservations and network measurements (2026-10-05)

**Choice:** source requests reserve budget immediately before every validated HTTP hop, including feed redirects. Each hop gets its own trace event attributed to the destination host. API startup timings are buffered until run creation and retain their actual start timestamps.

**Choice:** model input reserves the full UTF-8 serialized byte length plus chat-template headroom, rather than an average characters-per-token estimate. The full output ceiling is reserved too, and actual usage is reconciled afterward.

**Tradeoff:** this can stop research early with unused tokens. It is preferable to an unbounded token estimate; changing providers requires reviewing the tokenizer/template assumption.

## Model: `openai/gpt-oss-120b` (2026-10-05)

**Why:** the first live attempt (September 28) failed with Groq 404 `model_not_found` for `llama-3.3-70b-versatile`; Groq's model list for this key no longer includes it. `openai/gpt-oss-120b` is the strongest tool-calling chat model the key can use.

**Choice:** `reasoning_effort: low` and `max_output_tokens: 1000`. Hidden reasoning counts as output tokens, and low effort keeps it short enough to leave room for a `finish` call. The ceiling is kept small because Groq charges the full ceiling against the per-minute token limit.

**Tokenizer review:** gpt-oss uses a byte-level BPE tokenizer, so every token covers at least one UTF-8 byte and the byte-length input reservation remains an upper bound. Its chat template renders tool definitions more compactly than our JSON, and adds a short system header; the existing 2,048-token plus 256-per-message headroom covers that.

## Stay on Groq's free tier and pace model calls (2026-10-05)

**Why:** the free tier allows 8,000 tokens per minute and charges each request its prompt plus the full `max_completion_tokens` up front. This was measured: a 77-token prompt with a 64-token ceiling took 141 tokens from the bucket. Mid-run requests are several thousand tokens, so unpaced calls would hit per-minute 429s and exhaust their retries.

**Choice:** stay on the free tier ($0, nothing billable) rather than upgrade. The loop reads Groq's `x-ratelimit-*-tokens` headers and waits for the bucket to refill before each call. To make each request smaller, only the latest two tool results stay in full; older ones are summaries. The run time limit rose to 900 s (the server ceiling) and `max_total_tokens` to 100,000, still well under the 200,000 tokens per day.

**Tradeoff:** a run takes several minutes, mostly spent waiting on the rate limit. That wait time is visible in the trace. Two full runs fit in one day's token allowance.

## Ending runs cleanly when budgets run low (2026-10-05)

**Why:** two live test runs on a disposable account ended as partial. In the first, the model used all 16 steps without calling `finish`. In the second, it used its 4 searches on one company, and the next search ended the whole run.

**Choice:** on the last allowed step, only `finish` is offered and the model is told to call it. A tool whose own allowance (searches, search credits, fetches) is used up is no longer offered. If it is called anyway, it returns an error to the model instead of ending the run. Run-wide limits (steps, model calls, tokens, network requests, time) still stop the run. `max_steps` and `max_model_calls` rose to 20.

**Also fixed:** a generic careers page title such as "Duolingo Careers" cleaned to an empty title. That became an empty evidence quote, which the finalize API correctly rejected. Extraction now falls back to the next title candidate, and empty quotes are never recorded.

## Malformed tool calls and sampling temperature (2026-10-05)

**Why:** the third live test run failed at step 15. The model called a nonexistent tool (`commentary`), and Groq rejected it with `tool_use_failed`. The loop is meant to feed that back to the model, but the provider message was truncated to 200 characters before the code was checked, so the code wasn't recognized. Before that, the model had answered three turns with text and no tool call.

**Choice:** the Groq wrapper detects `tool_use_failed` from the structured error code and names it at the start of the message. Text-only replies are recorded (shortened) in the trace for diagnosis. Temperature is 1.0, as OpenAI recommends for gpt-oss ("We recommend sampling with temperature=1.0 and top_p=1.0", github.com/openai/gpt-oss); temperature 0 is a likely cause of the degenerate turns.

**Tradeoff:** the model's choices vary between runs. Facts, ranking, and reports are still produced by code from stored evidence.

## Keep a known posting's facts when a new URL carries fewer (2026-10-05)

**Why:** in a live test run the model fetched Robinhood's careers page (`job-boards.greenhouse.io/...`) instead of the job-board API record it had fetched before. Duplicate detection correctly matched them by job id, but the web page yielded no location. The posting lost its location score and fell out of the top 5. Across runs, that would be reported as a false "Dropped".

**Choice:** when a run observes a known posting, missing facts are filled from the last saved observation of that posting. The run's own observation stays the base, so newer facts win. Each filled-in quote still cites the document it came from, and that document is added to the posting's sources.

## Evidence runs use `openai/gpt-oss-20b` (2026-10-05)

**Why:** in live tests on a disposable account, `gpt-oss-120b` failed to finish (before later fixes), and its daily token pool was mostly used. A `gpt-oss-20b` run then completed cleanly in 17 steps (about 49K tokens), recovering from a malformed tool call and two per-minute 429s. Groq's free limits are per model and identical for both.

**Choice:** run 1 and run 2 use `gpt-oss-20b`. The model only chooses what to list, fetch, and search, and when to finish; facts, quotes, and ranking come from code, so the smaller model does not lower report accuracy.

**Tradeoff:** the smaller model wastes more steps on confused turns. It is cheaper at paid rates ($0.075 / $0.30 per million input/output tokens versus $0.15 / $0.60).

## Retries need their own model-call headroom (2026-10-05)

**Why:** the first `NYUgrader` run ended partial at `max_model_calls` (20/20). Late in the run, the model sent two malformed tool calls. Groq still charged their tokens against the per-minute bucket, but pacing updated only after successful calls, so the next requests drew per-minute 429s. Those retries used the remaining model calls before `finish`. Partial runs don't become the comparison baseline, so that run can't serve as run 1.

**Choice:** after a malformed tool call, pacing assumes the request's prompt and output ceiling were spent. `max_model_calls` is 26, leaving 6 attempts for retries above the 20 steps.
