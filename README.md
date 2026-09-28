# Intersearch

Intersearch is a personal internship research dashboard. A hand-written agent tracks summer 2027 software and backend internships at five companies, ranks the top five with evidence quoted from each posting, and reports what changed since the last run.

It is built for NYU FNMS Assignment 1 (the account app) and Assignment 1B (the tracker agent). The design and its tradeoffs are in [INTERSEARCH_PLAN.md](INTERSEARCH_PLAN.md), [AGENT.md](AGENT.md), and [docs/decisions.md](docs/decisions.md).

## Architecture

```text
Vue 3 app (localhost:5173) ──bearer token──> Express API (localhost:3000) ──Prisma──> Supabase Postgres
                                                  │
                                                  └─ Supabase Auth (passwords, bcrypt)
Tracker CLI ──bearer token──> Express API          (the tracker never touches the database directly)
     ├─> Groq (model)      ├─> Tavily (search)      └─> allowlisted job boards (guarded fetch)
```

- **Frontend:** Vue 3, Vue Router, Vite, plain CSS. It calls only the Express API.
- **Backend:** Express 5, Prisma 7 with `@prisma/adapter-pg`, Supabase PostgreSQL. Auth uses Supabase Auth through a server-only client, the same pattern as Cirilio.
- **Tracker:** TypeScript agent loop in `backend/src/tracker` (no agent framework). Model: Groq. Search: Tavily. Postings: Greenhouse's public Job Board API.

## Prerequisites

- **Node.js 22.13 or newer** (Node 24 also works). Check with `node -v`.
- **npm 10+** (comes with Node).
- **Python 3.9+**, only for the `python -m tracker.tools ...` command form.
- For the tracker only: a free **Groq** API key and a free **Tavily** API key (see [Keys](#keys-for-the-tracker)). The account app needs no keys.

## Run it (A1: backend and frontend)

Run these from a terminal, in order, in the repository root.

```bash
git clone https://github.com/stefanedelman/intersearch.git
cd intersearch
npm run setup
npm run db:migrate
npm run db:seed
```

- `npm run setup` installs both packages from their lockfiles and generates the Prisma client. It also creates `backend/.env.local` for your API keys.
- `npm run db:migrate` applies the checked-in migrations. It is safe to re-run.
- `npm run db:seed` creates or refreshes the grader account. It is safe to re-run.

Then start the two servers, each in its own terminal:

```bash
npm run dev:backend
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
| `backend/.env` | **Yes, on purpose** | Credentials for the **throwaway Supabase project made only for this course**: database URLs, project URL, and service-role key. It also holds non-secret settings and the course grader credentials. A1 allows committing this one database credential. The service-role key is committed on the same basis: it only reaches that same throwaway project. |
| `backend/.env.local` | No (ignored) | Your `GROQ_API_KEY` and `TAVILY_API_KEY`. Created empty by `npm run setup`. |
| `.env.example`, `backend/.env.example`, `frontend/.env.example` | Yes | Every variable, documented. |

The frontend needs no `.env`: it defaults to the API at `http://localhost:3000`.

<a id="supabase-setup"></a>
**Supabase setup** (only needed if you are recreating the course project, not for grading): create a new Supabase project used for nothing else, then fill in `backend/.env`:

- `DATABASE_URL`: the transaction pooler URL (port 6543).
- `DIRECT_URL`: the session pooler URL (port 5432).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: from Project Settings → API.

In Authentication settings, keep the default password policy and raise the sign-in rate limit if you run `npm run verify` many times. Free Supabase projects pause after a week idle; open the dashboard to wake one before grading.

## Run the tracker (A1B)

Keep the backend running (above). In order:

1. **Add keys.** Put your Groq and Tavily keys in `backend/.env.local`:

   ```text
   GROQ_API_KEY=gsk_...
   TAVILY_API_KEY=tvly-...
   ```

2. **Run the tracker.** It logs in as `NYUgrader`, reads `config.yaml`, researches, and saves the report:

   ```bash
   npm run tracker:run
   ```

3. **Run it again.** The second run skips pages it already fetched and reports **New since last run**, **Still in top K**, and **Dropped**:

   ```bash
   npm run tracker:run
   ```

4. **Reset the tracker's saved state.** This deletes the `NYUgrader` tracker history but keeps the account:

   ```bash
   npm run tracker:reset -- --confirm intersearch-development
   ```

Every run prints its status and writes `runs/<runId>/report.md` and `runs/<runId>/trace.jsonl` locally before uploading. The results appear on the dashboard (log in as `NYUgrader`), with run history and the articles fetched on each run.

- **Exit codes:** 0 complete, 2 partial (a budget ran out), 1 failed (for example, a bad key).
- **If the backend was unreachable at the end of a run,** the report is still on disk. Upload it later with `npm run tracker:sync -- --run RUN_ID`.
- **To export a run for submission:** `npm run tracker:export -- --run RUN_ID --label run1` writes `reports/run1.md` and `traces/run1.jsonl`.

Policy lives in [`config.yaml`](config.yaml): topic, K, model, instructions, tools, limits, allowed schemes and hosts, and companies. `tracker:run` re-reads it every time, so an edit (for example `max_steps: 2`) applies to the next run. Editing limits, model, or instructions keeps the run-to-run comparison. Changing the topic, K, preferences, or companies starts a new comparison.

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

It also enforces a timeout, a size cap that applies after decompression, and a redirect limit, re-checking every redirect hop. `finish` saves a report for an existing run from a draft file: `npm run tracker:tools -- finish --run RUN_ID --file draft.json`.

### Test with your own page

1. Add the page's host to `fetch_policy.allowed_hosts` in `config.yaml`.
2. Add the page's URL to `seed_urls`.
3. Run `npm run tracker:run`.

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

### Tracker endpoints (A1B)

All require a bearer token. Every lookup is scoped to the caller's own tracker.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/tracker` | your tracker, its config, the run in progress, and the latest run |
| PUT | `/api/tracker/config` | import validated `config.yaml` (the CLI does this every run) |
| GET | `/api/tracker/state` | saved state for the agent: fetched URLs, known developments, last top K |
| GET | `/api/tracker/documents/:id` | a saved page's text (for reuse without re-fetching) |
| GET | `/api/tracker/report/latest` | the latest report |
| POST | `/api/tracker/runs` | start a run → 201 `{runId, baselineRunId}` (one running run at a time) |
| GET | `/api/tracker/runs` | run history, newest first (`?cursor=&limit=`) |
| GET | `/api/tracker/runs/:id` | one run: status, totals, config snapshot |
| GET | `/api/tracker/runs/:id/report` | that run's report |
| GET | `/api/tracker/runs/:id/sources` | articles fetched on that run: title, URL, fetch time, status |
| GET | `/api/tracker/runs/:id/trace` | redacted trace events |
| POST | `/api/tracker/runs/:id/checkpoint` | upload pages, fetch attempts, and trace events (idempotent) |
| POST | `/api/tracker/runs/:id/finalize` | save the report; rejects quotes not found in their cited source |
| POST | `/api/tracker/reset` | `{confirm: "intersearch-development"}` → delete your tracker history |

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
| `TraceEvent` | every model call, tool call, and network round trip |

Deleting a profile cascades to everything under it.

## Evidence for grading

- `reports/run1.md`, `reports/run2.md`: genuine runs at least one day apart, exported with `tracker:export`.
- `traces/run1.jsonl`, `traces/run2.jsonl`: the matching redacted traces.
- [AGENT.md](AGENT.md): design answers, with numbers measured from those traces (`node scripts/trace-stats.mjs traces/run1.jsonl`).

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

- **Unit tests:** URL/DNS guardrails, decompression and size limits, config validation, identity and dedupe, fact extraction, ranking, report sections, 429 classification, budgets, and redaction.
- **Integration tests:** run the real API and tracker against an in-memory Postgres (PGlite) with a fake auth provider, a scripted model, and fixture pages. No network or paid APIs are used.

## Troubleshooting

- **"backend/.env still has placeholder values":** fill in the course Supabase project values ([Supabase setup](#supabase-setup)).
- **Database connection errors:** the free Supabase project may be paused; open its dashboard to resume it.
- **Frontend says it cannot reach the API:** start `npm run dev:backend`; the API must be on port 3000.
- **CORS errors:** the API allows `http://localhost:5173` by default; change `CORS_ALLOWED_ORIGINS` in `backend/.env` if you use another origin.
- **401 after a while:** tokens expire (Supabase default: 1 hour); log in again.
- **Tracker "GROQ_API_KEY is not set":** add it to `backend/.env.local`.
- **Tracker stops with `quota_exhausted`:** a daily provider limit is used up; it resets the next day, so retrying now will not help.
- **Tracker "Run ... is still in progress":** another run is active; runs idle for 10 minutes are closed automatically.

## Known limitations

- Saved pages are reused on later runs, so their text can go stale. The dashboard shows when each was fetched.
- A posting missing from a company's job feed is reported as "no longer listed". A posting simply not seen on a run is never called closed.
- Two postings with the same title and location but different job ids are kept separate on purpose. A repost under a new id looks new.
- Runs start from the CLI; the dashboard shows status but has no run button.
- Changing a password does not sign out existing sessions; tokens expire on Supabase's schedule instead.
- Provider free tiers are finite; see [docs/costs.md](docs/costs.md).
