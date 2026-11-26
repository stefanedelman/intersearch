# Intersearch

Intersearch is a personal internship research dashboard. A hand-written agent tracks summer 2027 software and backend internships at five companies and ranks the top five. A second agent checks every claim against the page it cites, and the dashboard reports what changed since the last run.

It is built for NYU FNMS Assignment 1 (the account app), Assignment 1B (the tracker agent), and Assignment 2 (agentic orchestration: the tracker split into an orchestrator, a researcher, and a verifier that talk only over HTTP). The design and its tradeoffs are in [INTERSEARCH_PLAN.md](INTERSEARCH_PLAN.md) and [AGENT.md](AGENT.md) (A1/1B), [ORCHESTRATION_PLAN.md](ORCHESTRATION_PLAN.md) and [ORCHESTRATION.md](ORCHESTRATION.md) (A2), and [docs/decisions.md](docs/decisions.md).

## Architecture

```text
Vue 3 app (:5173) ──user token──> Express API + orchestrator (:3000) ──Prisma──> Supabase Postgres (+ Supabase Auth)
                                      │
                                      ├─ POST /research  Bearer RESEARCHER_TOKEN ──> researcher (:4001, laptop)
                                      │                                                ├─> Groq (qwen/qwen3.8-27b)
                                      │                                                ├─> Tavily (search)
                                      │                                                └─> allowlisted job boards (guarded fetch)
                                      └─ POST /verify    Bearer VERIFIER_TOKEN   ──> verifier (Render free tier)
                                                                                       ├─> Groq (openai/gpt-oss-120b)
                                                                                       └─> each cited page (guarded fetch)
```

- **Frontend:** Vue 3, Vue Router, Vite, plain CSS. It calls only the Express API; it never sees a worker token.
- **Backend:** Express 5, Prisma 7 with `@prisma/adapter-pg`, Supabase PostgreSQL. Auth uses Supabase Auth through a server-only client, the same pattern as Cirilio.
- **Orchestrator** (`backend/src/orchestrator`, inside the API process): starts runs in the background, owns the run budget, retries, failure fallbacks, the report, and the database.
- **Researcher** (`backend/src/researcher`): the 1B agent loop (no agent framework) behind `POST /research`. Stateless.
- **Verifier** (`backend/src/verifier`, deployed on Render): fetches each cited page through the same SSRF guard, asks a different model for a verdict per claim, and checks every evidence excerpt against the page in code.
- **Contract** (`backend/src/shared/contract.ts`): the only code all three share, with the guarded fetch, the evidence normaliser, the trace writer, and the worker runtime in `backend/src/shared`. Workers never import each other or the orchestrator; a test enforces it.

## Prerequisites

- **Node.js 22.13 or newer** (Node 24 also works). Check with `node -v`.
- **npm 10+** (comes with Node).
- **Python 3.9+**, only for the `python -m tracker.tools ...` command form.
- Supabase credentials in your local `backend/.env` (see [Environment](#environment)). For the tracker, also provide a **Groq** API key and a **Tavily** API key.
- To try the dashboard with no credentials at all: `npm run setup` then `npm run demo` (in-memory database, fake login, scripted workers).

## Run it (A1: backend and frontend)

Run these from a terminal, in order, in the repository root.

```bash
git clone https://github.com/stefanedelman/intersearch.git
cd intersearch
cp backend/.env.example backend/.env
# Fill in backend/.env with your course Supabase credentials before continuing.
npm run setup
npm run db:migrate
npm run db:seed
```

- `npm run setup` installs both packages from their lockfiles and generates the Prisma client. It also creates `backend/.env.local` for your API keys and generates the two service tokens (`RESEARCHER_TOKEN`, `VERIFIER_TOKEN`).
- `npm run db:migrate` applies the checked-in migrations. It is safe to re-run.
- `npm run db:seed` creates or refreshes the grader account. It is safe to re-run.

Then start everything with one command. This installs dependencies, opens the backend, the researcher (and a local verifier, if configured) and the frontend in separate Terminal windows, and opens the app in your browser. Stop each server with Ctrl-C in its Terminal window:

```bash
./start.sh
```

Or run the whole stack in one terminal with prefixed output (Ctrl-C stops all of it):

```bash
npm run dev:all
```

Or start each separately, in its own terminal:

```bash
npm run dev:backend
```

```bash
npm run dev:researcher
```

```bash
npm run dev:frontend
```

Open <http://localhost:5173> and log in as the grader account:

- **Username:** `NYUgrader`
- **Password:** `Courant2026!`

The API is at <http://localhost:3000> (`GET /healthz` returns `{"status":"ok"}`). To check every A1 endpoint and rule against the running API:

```bash
npm run verify
```

### Environment

| File | In git? | Contents |
| --- | --- | --- |
| `backend/.env` | No (ignored) | Local credentials for the dedicated course Supabase project, non-secret settings (`RESEARCHER_URL`, `VERIFIER_URL`), and course grader credentials. Copy `backend/.env.example` and fill it in before setup. Never commit this file. |
| `backend/.env.local` | No (ignored) | `GROQ_API_KEY`, `TAVILY_API_KEY`, and the service tokens `RESEARCHER_TOKEN` and `VERIFIER_TOKEN` (generated by `npm run setup`). `VERIFIER_GROQ_API_KEY` and `VERIFIER_MODEL` only if you run a local verifier. |
| Render environment | — | The deployed verifier's `VERIFIER_TOKEN` (same value as locally), `VERIFIER_GROQ_API_KEY`, and `VERIFIER_MODEL`. See [docs/deploy-verifier.md](docs/deploy-verifier.md). |
| `.env.example`, `backend/.env.example`, `frontend/.env.example` | Yes | Every variable, documented. |

The frontend needs no `.env`: it defaults to the API at `http://localhost:3000`.

<a id="supabase-setup"></a>
**Supabase setup:** use the dedicated course Supabase project, or create a new project used for nothing else, then fill in your local `backend/.env`:

- `DATABASE_URL`: the transaction pooler URL (port 6543).
- `DIRECT_URL`: the session pooler URL (port 5432).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: from Project Settings → API.

In Authentication settings, keep the default password policy and raise the sign-in rate limit if you run `npm run verify` many times. Free Supabase projects pause after a week idle; open the dashboard to wake one before grading.

## Run the tracker (A2: from the dashboard)

Keep the backend and the researcher running (above), with `VERIFIER_URL` in `backend/.env` pointing at the verifier.

1. **Log in** as `NYUgrader` at <http://localhost:5173>.
2. **Check the workers.** The Run card shows the researcher and the verifier as up, asleep, down, or not configured. The verifier runs on Render's free tier, which sleeps after 15 idle minutes; **Wake verifier** wakes it (about a minute) and reports how long it took. A run also wakes it in parallel with research.
3. **Press Run tracker.** The API re-reads [`config.yaml`](config.yaml) and starts the run in the background. Live progress shows the phase (Waking → Researching → Verifying n/m → Writing report → Done), every request to a worker with its attempts and caller-side latency, and the run budget. **Cancel run** stops it and writes a partial report.
4. **Read the report.** Each development's claims carry a label: **Supported** (with an excerpt from the page that code confirmed is there), **Unsupported**, **Unreachable** (the page could not be fetched, or the guard refused it), or **Unverified** (the verifier failed, ran out of budget, or the run stopped). Sections show **New since last run**, **Still in top K**, **Returned**, and **Dropped**.

If a worker fails, the run still finishes: with the verifier down, claims are Unverified and the run is partial; with the researcher down, the previous top K is shown, marked stale. Run detail has **Claims** (filter by label) and **Network** (every worker request and attempt) tabs.

From a terminal, `npm run tracker:run` does the same through the same endpoint: it prints worker health, phases, and worker calls, and Ctrl-C cancels.

Every run writes `runs/<runId>/report.md`, `runs/<runId>/orchestrator.jsonl`, and, collected from the workers right after the run, `runs/<runId>/researcher.jsonl` and `runs/<runId>/verifier.jsonl`.

- **To export a run for submission:** `npm run tracker:export -- --run RUN_ID --label a2-run1` writes `reports/a2-run1.md` and `traces/a2-run1/{orchestrator,researcher,verifier}.jsonl`. It never overwrites existing evidence.
- **To reset the tracker's saved history** (keeps the account): `npm run tracker:reset -- --confirm intersearch-development`.

Policy lives in [`config.yaml`](config.yaml): topic, K, model, instructions, tools, the researcher's limits, allowed hosts, companies, and the `orchestration` block (the run's total budget, the researcher/verifier split, time budgets, timeouts, and retries). Editing limits, model, or instructions keeps the run-to-run comparison. Changing the topic, K, preferences, or companies starts a new comparison.

### Check the workers directly

```bash
node scripts/smoke-verifier.mjs
```

```bash
npm run contract-check -- --target researcher
```

```bash
npm run contract-check -- --target verifier
```

The smoke test times the verifier's cold start and checks auth, the SSRF guard, a real verification, and replay. The contract check runs the assignment's "Test it yourself" matrix (401, 400, 409, 503 + Retry-After, replay with no new trace lines, partial on a tiny time budget, unreachable internal URLs) and validates every answer against the contract; `--save` writes `docs/contract-check-<target>-<date>.md`.

### Keys for the tracker

- **Groq:** get a key at <https://console.groq.com/keys>. The free tier has per-minute and per-day limits; the tracker waits out per-minute limits and stops on daily ones.
- **Tavily:** get a key at <https://app.tavily.com>. Each `search_web` call costs 1 credit.

Set a spend cap or use an unfunded free tier for both before the first run.

### Call a tool without the model

Each tool runs standalone with the same guardrails as the agent. No backend, login, or model key is needed (`search_web` still needs the Tavily key):

```bash
python -m tracker.tools fetch_article 'https://boards-api.greenhouse.io/v1/boards/figma/jobs/6143238004'
```

```bash
python -m tracker.tools fetch_article 'http://169.254.169.254/latest/meta-data'
```

```bash
npm run tracker:tools -- list_company_jobs stripe
```

```bash
npm run tracker:tools -- search_web 'Robinhood backend intern summer 2027'
```

`fetch_article` prints JSON and exits 0 when fetched, 3 when rejected by a guardrail, and 4 when the fetch failed. It rejects:

- any scheme other than http(s), and URLs with embedded credentials;
- ports other than 80 and 443;
- hosts not in `fetch_policy.allowed_hosts`;
- any host that is or resolves to a loopback, private, link-local, or other non-public address, before a connection is made.

It also enforces a timeout, a size cap that applies after decompression, and a redirect limit, re-checking every redirect hop.

### Test with your own page

1. Add the page's host to `fetch_policy.allowed_hosts` in `config.yaml`.
2. Add the page's URL to `seed_urls`.
3. Start a run from the dashboard (or `npm run tracker:run`).

The agent fetches seed URLs first; every guardrail still applies. Page text reaches the model only as labeled data inside tool results, and the tools, hosts, and budgets are fixed in code. The dashboard renders all fetched text with Vue's text interpolation (never `v-html`), so markup or script in a page shows as plain text.

## API

JSON in, JSON out. Protected routes take `Authorization: Bearer <token>`.

- **401:** a missing, invalid, or expired token, or the token of a deleted account. **503:** Supabase Auth is unreachable.
- **404:** any other user's id, a nonexistent id, or a malformed id.

We return 404 rather than 403: a 403 would confirm that an account exists, which lets someone enumerate users. The check order is authentication (401), then ownership (404), then input validation (400). So another user's id gets 404 even with an invalid body.

### Account endpoints (A1)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/healthz` | no | returns `{ "status": "ok" }` |
| POST | `/api/auth/register` | no | `{username, password, email?}` → 201 `{user, token, expiresAt}` |
| POST | `/api/auth/login` | no | `{username, password}` or `{email, password}` → 200 `{token, expiresAt, user}` |
| GET | `/api/auth/me` | yes | the logged-in user `{user}` |
| GET | `/api/users/:id` | yes | read your own user `{user}` |
| PATCH | `/api/users/:id` | yes | update your own `{username?, email?, password?}` → `{user}`; your token stays valid |
| DELETE | `/api/users/:id` | yes | delete your own account → `{ok: true}`; its token stops working |

A user is `{id, username, email, createdAt, updatedAt}`. Password hashes are never returned: they exist only inside Supabase Auth (bcrypt, in `auth.users`), and our API never reads that table.

### Tracker endpoints

All require a bearer token. Every lookup is scoped to the caller's own tracker.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tracker` | your tracker, its config, the run in progress (with phase), and the latest run |
| PUT | `/api/tracker/config` | import a validated config (a run start re-reads `config.yaml` and does this itself) |
| GET | `/api/tracker/report/latest` | the latest report |
| POST | `/api/tracker/runs` | `{idempotencyKey}` → **202** `{runId}`; the run continues in the background. The same key never starts two runs; 409 while another run is active; 503 if a worker token is missing |
| POST | `/api/tracker/runs/:id/cancel` | stop the run now → 202; 409 once it has finished |
| GET | `/api/tracker/runs` | run history, newest first (`?cursor=&limit=`), with kind, failed workers, and claim counts |
| GET | `/api/tracker/runs/:id` | one run: status, phase, budget ledger, and every worker call with its attempts |
| GET | `/api/tracker/runs/:id/report` | that run's report (v1 for 1B runs, v2 for orchestrated runs) |
| GET | `/api/tracker/runs/:id/claims` | claims with labels and evidence (`?label=supported` etc.) |
| GET | `/api/tracker/runs/:id/sources` | 1B runs: articles fetched on that run |
| GET | `/api/tracker/runs/:id/trace` | 1B runs: redacted trace events |
| GET | `/api/tracker/workers` | both workers' health, probed by the server (up, asleep, down, not configured) |
| POST | `/api/tracker/workers/verifier/wake` | wait for the verifier to answer and report how long it took |
| POST | `/api/tracker/reset` | `{confirm: "intersearch-development"}` → delete your tracker history |

### Worker endpoints (Assignment 2 contract)

Called only by the orchestrator, with a per-worker bearer token. The request envelope is the assignment's (`request_id`, `run_id`, `time_budget_ms`, `budget{max_steps, max_fetches, max_tokens}`, `payload`); the response envelope is `{request_id, run_id, service, status, result, error, usage}`. See [`backend/src/shared/contract.ts`](backend/src/shared/contract.ts) and [ORCHESTRATION.md](ORCHESTRATION.md).

| Worker | Method | Path | Answers |
| --- | --- | --- | --- |
| researcher, verifier | GET | `/healthz` | `{status: "ok"}`, no auth |
| researcher | POST | `/research` | 200 complete/partial, 500 failed, 400 invalid, 401 bad token (checked before the body), 409 same id with another body, 503 + Retry-After while the same id is in flight |
| verifier | POST | `/verify` | the same codes; `result.verdicts[]`, evidence ≤ 300 characters and checked against the page |
| researcher, verifier | GET | `/trace?run_id=` | that run's trace lines (token required) |

## Database schema

Postgres, managed by Prisma. See [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma). Supabase Auth owns credentials in its own `auth` schema.

| Table | What it stores |
| --- | --- |
| `Profile` | one row per Supabase Auth user: `id` (= auth user id), `username`, `normalizedUsername` (unique, lowercase), `hasRealEmail` |
| `Tracker` | one per profile: active config, `configHash`, `comparisonKey` (hash of topic, K, preferences, companies) |
| `CompanySource` | configured companies: careers URL, job-board token, allowed hosts |
| `Run` | each run: status, times, config snapshot, `baselineRunId`, stop reason, budget totals |
| `SourceDocument` | every fetched page: canonical URL, final URL, title, text, content hash, structured metadata; versioned, never overwritten |
| `FetchAttempt` | every `fetch_article` call on a run, with status `fetched`, `skipped_seen`, `rejected`, or `failed` |
| `Opportunity` | one row per real internship (development), keyed by `identityKey` (e.g. `greenhouse:stripe:8128745`) |
| `OpportunitySource` | which pages support each development and how they were matched |
| `OpportunityObservation` | the facts and quotes seen for a development on a given run |
| `Report` / `ReportItem` | the saved report per run and its ranked items (`new`, `still`, `returned`, `dropped`) |
| `TraceEvent` | 1B runs: every model call, tool call, and network round trip |
| `WorkerCall` | orchestrated runs: one row per request to a worker (written before sending): share, attempts, final status, caller-side latency, reported and charged usage |
| `Claim` | orchestrated runs: each claim with its label (`supported`, `unsupported`, `unreachable`, `unverified`), evidence, and the verify request that labelled it |

`Run` also records `kind` (`tracker` for 1B, `orchestrated`), `phase`, `failedWorkers`, `stale`, the budget `ledger`, and `cancelRequested`. All Assignment 2 migrations are additive; 1B rows are unchanged.

Deleting a profile cascades to everything under it.

## Evidence for grading

### Assignment 2

See [ORCHESTRATION.md](ORCHESTRATION.md) for the five answers, with measured numbers.

- **a2-run1:** [`reports/a2-run1.md`](reports/a2-run1.md) and [`traces/a2-run1/`](traces/a2-run1) (orchestrator, researcher, verifier). Run `ac6be8df-f718-471f-83ea-c82722c2432c`, started from the dashboard as `NYUgrader` on 2026-11-26 with the Render verifier asleep (wake-up 15.1 s, hidden behind research). **Partial:** the researcher used its 18 steps and ranked 2 of K = 5; all 6 claims are supported.
- **a2-run2:** [`reports/a2-run2.md`](reports/a2-run2.md) and [`traces/a2-run2/`](traces/a2-run2). Run `c7007e9c-c80d-4df8-89c6-db7462d7344b`, 25 minutes later, compared with run 1 (both postings still in the top K). Same outcome. Its tool-call trace showed why: `finish` was rejected on the last step. That bug is fixed; see ORCHESTRATION.md §5.
- **Contract checks:** [researcher 9/9](docs/contract-check-researcher-2026-11-25.md), [verifier on Render 10/10](docs/contract-check-verifier-2026-11-26.md). Deploy steps: [docs/deploy-verifier.md](docs/deploy-verifier.md).
- **Hand-check sheet:** [docs/handcheck-a2-run1.md](docs/handcheck-a2-run1.md).

### Assignment 1B

- **Run 1:** [`reports/run1.md`](reports/run1.md) and [`traces/run1.jsonl`](traces/run1.jsonl). Run `255a44ee-61bf-459c-8889-523126d62283`, **complete**, 2026-10-06 01:52–01:58 UTC (2026-10-05, 9:52 PM New York), model `qwen/qwen3.8-27b`, logged in as `NYUgrader`. It is on the dashboard under that account.
- **Run 2: not captured.** Submission was due before a run at least a day after run 1 was possible. The recrawl behavior was covered by the 1B test `tests/integration/tracker-e2e.test.ts` at commit `4b6dd54` (Assignment 2 replaced the 1B write path; the New / Still / Dropped comparison now lives in the orchestrator and is covered by `tests/integration/orchestration-e2e.test.ts`). Run 1 itself shows the cache at work: all 7 postings were `skipped_seen`, reused from earlier attempts on the same account.
- **Earlier attempts in `NYUgrader`'s history:** a failed run on 2026-09-28 (the configured model had been retired), and three attempts on 2026-10-05 that stopped partial or failed. Each exposed a bug that was fixed before run 1 (see [docs/decisions.md](docs/decisions.md)). They are kept, not deleted.
- **Provenance check (2 claims, done against the live sources on 2026-10-06):**
  - Robinhood, "Software Engineering Intern, Backend (Summer 2027)": the report says pay is "$60—$60 USD (hourly)" and lists New York, NY. The cited <https://boards-api.greenhouse.io/v1/boards/robinhood/jobs/8123225> contains "$60 — $60 USD", and its location field reads "Bellevue, WA; Menlo Park, CA; New York, NY". ✔
  - Figma, "Software Engineer Intern (Summer 2027)": the report says summer 2027 and "$55—$55 USD (hourly)". The cited <https://boards-api.greenhouse.io/v1/boards/figma/jobs/6143238004> has the title "Software Engineer Intern (Summer 2027)" and contains "$55 — $55 USD". ✔
- [AGENT.md](AGENT.md): design answers, with numbers measured from the run-1 trace (`node scripts/trace-stats.mjs traces/run1.jsonl`).

## Tests

```bash
npm run test:unit
```

```bash
npm run test:integration
```

```bash
npm run typecheck
```

```bash
npm run build
```

- **Unit tests:** the wire contract, the worker runtime (auth before parsing, idempotency states, deadlines), URL/DNS guardrails including a redirect to the metadata address, the evidence normaliser, the verifier, the researcher service, the ledger, the worker client (backoff, Retry-After, same bytes on retry), response validation, report sections, config, ranking, budgets, redaction, and the import boundary between services.
- **Integration tests:** run the real API, orchestrator, researcher, and verifier in-process against an in-memory Postgres (PGlite) with a fake auth provider, scripted models, and fixture pages: the happy path, verifier down, researcher down (stale), a foreign claim_id, a slow verifier (503 + Retry-After, then the stored answer, charged once), a verifier restart between attempts, tiny budgets, cancel, run-to-run comparison, every API endpoint, and the additive migration. No network or paid APIs are used.

## Troubleshooting

- **"backend/.env still has placeholder values":** fill in the course Supabase project values ([Supabase setup](#supabase-setup)).
- **Database connection errors:** the free Supabase project may be paused; open its dashboard to resume it.
- **Frontend says it cannot reach the API:** start `npm run dev:backend`; the API must be on port 3000.
- **CORS errors:** the API allows `http://localhost:5173` by default; change `CORS_ALLOWED_ORIGINS` in `backend/.env` if you use another origin.
- **401 after a while:** tokens expire (Supabase default: 1 hour); log in again.
- **Tracker "GROQ_API_KEY is not set":** add it to `backend/.env.local`.
- **Tracker stops with `quota_exhausted`:** a daily provider limit is used up; it resets the next day, so retrying now will not help.
- **Tracker "Run ... is still in progress":** another run is active; runs idle for 10 minutes are closed automatically, and runs left by a restarted API are closed at startup.
- **Run button disabled, "not configured":** set `RESEARCHER_TOKEN` and `VERIFIER_TOKEN` in `backend/.env.local` (`node scripts/setup-env.mjs` generates them) and restart the API.
- **Verifier "asleep":** the Render free instance is waking up; press **Wake verifier** or just start the run (it wakes the verifier in parallel with research).
- **Researcher "down":** start it with `npm run dev:researcher` (it needs `GROQ_API_KEY`). A run with the researcher down shows the previous top K, marked stale.

## Known limitations

- Saved pages are reused on later runs, so their text can go stale. The dashboard shows when each was fetched.
- A posting missing from a company's job feed is reported as "no longer listed". A posting simply not seen on a run is never called closed.
- Two postings with the same title and location but different job ids are kept separate on purpose. A repost under a new id looks new.
- The verifier's idempotency store is in memory: if Render restarts it between a request and its retry, the retry is recomputed (the orchestrator still charges it once). See ORCHESTRATION.md §3.
- A supported label means the excerpt is on the cited page and a model judged it supports the claim; the code checks the excerpt, not the judgement.
- Changing a password does not sign out existing sessions; tokens expire on Supabase's schedule instead.
- Provider free tiers are finite; see [docs/costs.md](docs/costs.md).
