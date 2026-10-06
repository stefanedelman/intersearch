# Intersearch completion checklist

Last updated: **October 5, 2026 (America/New_York)**.

**Status: core implementation complete enough for live validation; Assignment 1B submission is not complete.** The current code passes 74 unit tests and 22 integration tests, typechecks, and a production build. Real Supabase connectivity and `NYUgrader` login were verified. Successful research runs and the required submission evidence are still missing.

This is the working completion checklist for [the build plan](INTERSEARCH_PLAN.md) and [Assignment 1B](<FNMS Fall 2026 Assignment 1B.pdf>). A checked implementation item means the code exists; it does not mean a genuine research run has demonstrated it. Unchecked items include remaining work, final verification, and user-owned submission actions. Optional features are separated at the end.

## 1. Completed: project foundation and A1 app

- [x] Set up the TypeScript project with Node >=22.13, package lockfiles, environment examples, and root development/build/test scripts.
- [x] Build the Vue 3, Vue Router, Vite, and plain-CSS frontend.
- [x] Build the Express 5 backend with request validation and JSON error responses.
- [x] Integrate Prisma 7, `@prisma/adapter-pg`, and the dedicated Supabase PostgreSQL course database.
- [x] Implement database schema, migrations, and database access restrictions.
- [x] Integrate server-side Supabase Auth; the frontend calls Express rather than Supabase directly.
- [x] Implement register, login, current-user lookup, account lookup, account edits, and account deletion.
- [x] Keep password storage/hashing in Supabase Auth and omit password hashes from application responses.
- [x] Enforce bearer authentication, 401 responses, and account ownership checks.
- [x] Return uniform 404 responses for other users' account resources and document the rationale.
- [x] Support the grading flow that reuses an access token after a password change.
- [x] Implement registration, login, dashboard/home, and account screens, including logout.
- [x] Configure local frontend/backend CORS.
- [x] Implement the repeatable grader-account seed script.
- [x] Create the personal GitHub repository and configure `origin` to `stefanedelman/intersearch`.
- [x] Keep `backend/.env` and `backend/.env.local` ignored; track placeholder examples only.
- [x] Follow the user's no-staging, no-commit, no-push rule during this work.
- [x] Keep Cirilio separate; do not modify it or reuse its database or credentials.

## 2. Completed: tracker implementation

### Configuration and agent

- [x] Configure a narrow topic: summer 2027 software/backend internships, with K=5.
- [x] Configure Datadog, Stripe, Figma, Robinhood, and Duolingo, with source notes in [docs/sources.md](docs/sources.md).
- [x] Put topic, preferences, model, instructions, enabled tools, budgets, allowed schemes, and allowed hosts in [config.yaml](config.yaml).
- [x] Validate configuration with Zod and apply server ceilings.
- [x] Reload configuration on each run and save its snapshot/hash.
- [x] Keep comparisons intact when only limits/model/instructions change; separate comparisons when the tracking target changes.
- [x] Implement a hand-written research loop without an agent framework.
- [x] Implement `search_web`, `fetch_article`, `finish`, and `list_company_jobs`.
- [x] Provide independently callable tools through both npm and `python -m tracker.tools`.
- [x] Integrate Groq, Tavily, and public Greenhouse job feeds.
- [x] Add local provider-key values in the ignored environment file. Presence was verified; successful provider use still needs validation.

### Persistence, ranking, and reports

- [x] Have the tracker save/load state only through authenticated Express APIs; tracker modules do not import Prisma.
- [x] Save fetched documents, URLs, fetch attempts, developments, source relationships, run history, reports, and trace events.
- [x] Reuse cached articles without fetching their source URLs again.
- [x] Recognize aliases of the same underlying job using company/provider identifiers.
- [x] Preserve the previous completed top K and all-time reported-development memory.
- [x] Extract factual fields and supporting quotes from stored source text.
- [x] Rank deterministically with role, season, location, skills, and freshness criteria.
- [x] Apply hard exclusions and represent missing information as unknown.
- [x] Generate New since last run, Still in top K, Returned to top K, and Dropped distinctions.
- [x] Keep partial runs from replacing the completed comparison baseline.
- [x] Produce honest short/empty reports when fewer than K supported matches exist.
- [x] Validate source ownership and evidence quotes at API finalization.
- [x] Implement run/config/sync/export/reset CLI commands.
- [x] Implement idempotent checkpoint/finalize behavior and abandoned-run handling.
- [x] Save local reports and traces before final upload, with later sync support.

### Guardrails, failures, and display

- [x] Reject non-HTTP(S) schemes, disallowed hosts/ports, embedded URL credentials, and unsafe IP addresses.
- [x] Validate DNS results, pin connections to validated addresses, and revalidate redirects.
- [x] Enforce fetch timeouts and streamed size limits, including decompressed size.
- [x] Enforce step, model/tool call, fetch/search, external-request, token/credit, and elapsed-time budget checks in code.
- [x] Distinguish transient failures from bad keys, exhausted quotas, payment failures, and ambiguous rate limits.
- [x] Bound retries; do not retry confirmed daily quota exhaustion.
- [x] Keep tools, hosts, and budgets outside the model's control.
- [x] Render web-derived content as text in Vue, with safe HTTP(S) source links.
- [x] Implement authenticated latest-report, run-history, and run-detail screens.
- [x] Show source attempts, statuses, report exports, and trace details.
- [x] Redact sensitive values in trace/log output.

## 3. Completed: October 5 audit fixes

- [x] Save a partial report when loading previous state fails after the server creates a run; make no model request in this case.
- [x] Preserve gathered evidence during a mid-run outage and retain pending uploads for later sync.
- [x] Reserve the external-request budget before every source redirect hop, including job-feed redirects.
- [x] Replace characters/3 token estimation with UTF-8 byte reservations plus template headroom and the full output ceiling.
- [x] Avoid charging a network request for a model call rejected before dispatch by the token budget.
- [x] Remove free-form model reasons from optional report notes; allow only verified source quotes.
- [x] Enforce the quote-only note contract at both tool validation and the finalize API.
- [x] Reject `finish` calls referring to unknown sources, including on an otherwise empty run.
- [x] Include login, configuration import, and run-creation requests in traces by buffering their timings until the run id exists.
- [x] Preserve actual API request start times and include response-body reading in latency.
- [x] Trace source redirect hops individually under their destination hosts.
- [x] Fix parent event IDs so HTTP events link to the correct tool span.
- [x] Record finish-tool arguments and latency.
- [x] Update the quote display and implementation documentation.
- [x] Add regression coverage for these changes in [runtime-safety.test.ts](backend/tests/unit/runtime-safety.test.ts) and [tracker-e2e.test.ts](backend/tests/integration/tracker-e2e.test.ts).

Token reservations are intentionally conservative and may stop a run with unused tokens. The bound assumes the configured model's byte-level tokenization and includes template headroom; review it when changing providers/templates. Passing tests is not a claim that every possible failure mode has been proven safe.

## 4. Verification completed

| Check | Latest verified result |
| --- | --- |
| Unit suite | 74 passed |
| Integration suite | 22 passed |
| TypeScript checks | Backend and frontend passed |
| Production build | Backend and frontend passed |
| Diff whitespace check | Passed |
| Standalone Python fetch command | Loopback URL rejected before connecting |
| Dedicated course database | Read-only connectivity check passed |
| Supabase Auth health | HTTP 200 |
| Real `NYUgrader` login | HTTP 200 |
| Authenticated `/api/auth/me` | HTTP 200 |
| Authenticated tracker and history endpoints | HTTP 200 |

Automated tests use an isolated database, fake auth, a scripted model, and fixture pages. They are not genuine run-1/run-2 evidence. The build plan records an earlier full A1 verification run; the October 5 live check covered login and read access, not the entire account-mutation sequence.

At the latest live check, the grader history contained one failed research run dated September 28 in New York time (September 29 UTC). Its local trace recorded one model call with `bad_request`, and its report had zero ranked items. It is not the required successful run 1. No database reset was performed.

## 5. Remaining: prepare a successful genuine run

Do these before selecting run 1 for submission.

- [x] Verify Groq and Tavily account plans, hard spend caps or unfunded/no-overage allocations, and verification dates in [docs/costs.md](docs/costs.md). Both are free plans with nothing billable (verified 2026-10-05).
- [x] Record current account-specific minute/day/month limits and the configured model's availability. Do not substitute remembered allowances for verified ones. Groq's free plan: 30 RPM, 1K RPD, 8K TPM, 200K TPD (headers confirm 1K RPD and 8K TPM); Tavily: 1,000 credits/month.
- [ ] Validate the provider keys through a controlled live attempt after spend limits are confirmed. Groq passed a minimal call on 2026-10-05; Tavily's key passed `GET /usage`, but no search has been made yet.
- [ ] Inspect the earlier `bad_request` failure, resolve any remaining provider/request incompatibility, and confirm a live run can finish successfully. Cause: Groq 404 `model_not_found` for `llama-3.3-70b-versatile`. Fixed by switching to `openai/gpt-oss-120b` and pacing calls to the free tier's 8K TPM ([decisions](docs/decisions.md)). A successful live run is still pending.
- [ ] Recheck that configured source feeds are available, permitted, and yield relevant internship candidates.
- [ ] Confirm the final topic/preferences/K before run 1; avoid changing the tracking target between evidence runs.
- [ ] Verify the real search/fetch/observe/decide/finish path. Ensure genuine search usage is demonstrated as required by the build plan; do not invent search activity if feeds cover everything.
- [ ] Make any necessary fixes, then rerun the checks affected by those changes.

## 6. Remaining: capture run 1 and run 2

**Preserve the grader's tracker state and all evidence once genuine run 1 exists. Do not reset that tracker or reseed/change the evidence account casually. A second immediate run does not satisfy the one-day separation.**

### Run 1

- [ ] Start the backend and frontend using the README instructions.
- [ ] Confirm the tracker is configured to log in as `NYUgrader`.
- [ ] Execute `npm run tracker:run` with real providers and real sources.
- [ ] Confirm successful completion and inspect the ranked results for relevance and factual accuracy.
- [ ] If fewer than five suitable roles exist, retain an honest report; investigate source/configuration coverage before deciding it is suitable submission evidence.
- [ ] Record the run id, actual timestamp, and earliest eligible run-2 time in the table below.
- [ ] Export the selected run: `npm run tracker:export -- --run RUN_ID --label run1`.
- [ ] Verify `reports/run1.md` and `traces/run1.jsonl` exist and correspond to that run.
- [ ] Verify the report, history entry, and article attempts in the actual grader UI.

### Run 2, at least 24 hours later

- [ ] Wait at least 24 actual hours after run 1; record timestamps rather than relying on calendar dates.
- [ ] Preserve the same tracker, tracking target, and saved memory.
- [ ] Execute `npm run tracker:run` again.
- [ ] Confirm run 2 uses run 1 as the intended completed baseline and reuses cached articles.
- [ ] Inspect New/Still/Dropped and any Returned entries for correct identities and classifications. Zero new findings is acceptable if that is what the evidence shows.
- [ ] Record an actual alias/deduplication example if one occurs; otherwise clearly identify the existing fixture demonstration as a fixture.
- [ ] Export: `npm run tracker:export -- --run RUN_ID --label run2`.
- [ ] Verify `reports/run2.md` and `traces/run2.jsonl` exist, match run 2, and show the required time separation.
- [ ] Verify both runs and their source-attempt tables remain accessible to `NYUgrader`.

| Evidence | Run id | Actual timestamp with timezone | Status |
| --- | --- | --- | --- |
| Run 1 | Pending | Pending | Not captured |
| Earliest eligible run 2 | — | Run 1 timestamp + at least 24 hours | Pending |
| Run 2 | Pending | Pending | Not captured |

### Provenance and artifact review

- [ ] Check at least two concrete report claims against their cited sources, especially salary, eligibility, season, and location.
- [ ] Record the claims, source URLs, supporting excerpts, and audit result without including credentials.
- [ ] Inspect both exports for accurate rankings, sections, status, source links, and timestamps.
- [ ] Confirm traces contain the calls needed for network/cost analysis and contain no secrets.
- [ ] Keep the original local run artifacts and database history alongside the submission exports.

## 7. Remaining: finish documentation

Existing drafts: [README.md](README.md), [AGENT.md](AGENT.md), [JOURNAL.md](JOURNAL.md), [docs/decisions.md](docs/decisions.md), [docs/sources.md](docs/sources.md), and [docs/costs.md](docs/costs.md).

- [x] Draft README setup commands, environment guidance, API tables, schema, tracker commands, troubleshooting, and limitations.
- [x] Write system-specific AGENT.md explanations of model/code decisions, development identity, and failure classification.
- [x] Draft source notes, design decisions, and the assignment journal.
- [ ] Run `node scripts/trace-stats.mjs traces/run1.jsonl` and fill AGENT.md section 2 with actual round trips per service, latency distribution, and where time went.
- [ ] Fill AGENT.md section 5 and docs/costs.md with actual calls, input/output tokens, search credits, wall time, billed cost, and any paid-equivalent calculation.
- [ ] Calculate which allowance would limit daily use first, with verified reset periods and assumptions. For zero search-credit use, explicitly handle that case rather than dividing by zero.
- [ ] Remove all unresolved measurement/verification placeholders from the submission documentation.
- [ ] Review all five AGENT.md answers against the final implementation and evidence; label fixture examples and measured outcomes accurately.
- [ ] Add actual run ids/dates and evidence links to the README.
- [ ] Add an actual UI screenshot to the README, as requested by the build plan.
- [ ] Finish JOURNAL.md in the user's own voice, covering learning/enjoyment as well as decisions and challenges; check the course's roughly half-page formatting requirement.
- [ ] Reconcile stale build-plan status: older test counts, key/remote setup marked pending, the old project path, and superseded instructions to commit environment credentials.
- [ ] Recheck README command order, current repo URL, known limitations, and configuration examples against the final code.

**Environment policy remains unchanged:** credentials stay local and ignored. Older plan text allowing committed credentials is superseded. Arrange grader configuration/access appropriately without putting secrets into this checklist or Git.

## 8. Remaining: final grading rehearsal

These are acceptance checks, not a request to add new product features.

- [ ] Rehearse the documented setup from a clean clone/copy: prerequisites, installation, Prisma generation, local environment setup, migrations, and server startup.
- [ ] Confirm a grader can obtain/configure the necessary course environment without relying on this working directory's ignored files.
- [ ] Run the full A1 verification script using its disposable test accounts; do not mutate/delete the evidence account or reset its tracker.
- [ ] Test real browser flows: login, latest report, history, run detail, article statuses, source links, and report export.
- [ ] Check direct-route reload, loading/error/empty states, history pagination, and narrow/desktop layouts.
- [ ] Rehearse low-budget partial output, a bogus key, and network interruption through the CLI using a separate test tracker/account; preserve grader evidence.
- [ ] Confirm the standalone tool commands behave as documented, including bad URLs and an allowed public test page.
- [ ] Confirm an injection fixture cannot change policy or execute script in the UI; the automated fixture coverage already passes.
- [ ] Rehearse reset only on a disposable tracker/account. Never run the README's reset command against the preserved `NYUgrader` evidence.
- [ ] Run final unit/integration tests, typechecks, and build after any further code changes; update counts here if they change.
- [ ] Review final tracked files and relevant Git history for secrets; the current environment-ignore policy and redaction tests do not replace a final submission scan.
- [ ] Confirm Supabase is reachable and grader login still works close to grading time.

Useful non-destructive checks from the repository root:

```bash
npm run test:unit
npm run test:integration
npm run typecheck
npm run build
```

## 9. Remaining: repository and submission (user-owned)

- [ ] Confirm the required class organization and create/transfer the submission repository there.
- [ ] Update the README clone URL and Git remote if needed, with explicit user authorization for remote changes.
- [ ] Have the user review the final changes, including the new runtime helper/test files and this checklist.
- [ ] Have the user stage, commit, and push the code, configuration, documentation, and both report/trace pairs. These actions have not been performed by the agent.
- [ ] Confirm the submitted repository contains all required files and the graders have access.
- [ ] Submit the correct repository URL in Brightspace.
- [ ] Record submission confirmation; do not mark submission complete based only on a successful push.

## 10. Optional later work — not a submission blocker

- Hosted/Vercel deployment; local grading remains required.
- A dashboard button to launch runs, with a queue/worker.
- Scheduled tracking, notifications, and shared provider-quota management.
- CI or a broader browser-automation suite.
- Resume uploads, automatic applications, email, additional trackers, or other product expansion.

Do not delay the required live evidence and documentation to build these features.

## Completion condition

Mark the assignment complete only after successful genuine run evidence exists at least 24 hours apart, the grader can inspect it, measured documentation is finished, the clean-setup rehearsal passes, and the class repository URL has been submitted. The existing code/tests are a completed foundation, not a substitute for those deliverables.
