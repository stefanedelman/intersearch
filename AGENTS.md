# Agent rules for Intersearch

Intersearch is a personal internship research dashboard built for NYU FNMS Assignment 1, 1B, and 2. `INTERSEARCH_PLAN.md` is the build specification for A1/1B; `ORCHESTRATION_PLAN.md` is the build specification for Assignment 2 (agentic orchestration). Read the relevant one before changing anything.

## Git

- Never stage, commit, or push. The user stages and commits their own changes unless they explicitly authorize otherwise for a specific operation.
- Do not rewrite history or change remotes without asking.

## Stack (matches Cirilio)

- TypeScript everywhere; Node `>=22.13`.
- Frontend: Vue 3, Vue Router, Vite, plain CSS. The frontend calls only our Express API and never imports `@supabase/supabase-js`.
- Backend: Express 5, Prisma 7 with `@prisma/adapter-pg`, Supabase PostgreSQL, Supabase Auth through a server-only service-role client.
- Agents: hand-written loops and routing. No agent or multi-agent frameworks (LangGraph, CrewAI, AutoGen, OpenAI Agents SDK handoffs, and similar); model SDKs and HTTP libraries are fine.
- Three services, one network: the orchestrator (`backend/src/orchestrator`, inside the Express API process), the researcher (`backend/src/researcher`), and the verifier (`backend/src/verifier`, deployed on Render). Workers talk to the orchestrator only over the HTTP contract in `backend/src/shared/contract.ts`.
- Only the orchestrator and the API's own services read or write the database through Prisma. Researcher and verifier code never imports Prisma, the orchestrator, the API services, or each other; they may import only `backend/src/shared/`.
- Zod for validating environment, config, requests, tool calls, and reports.

## Greenfield rules

- No existing users or data to preserve. Replace earlier schemas, components, and interfaces outright; no compatibility layers or feature flags.
- Development database resets are allowed only against the dedicated Intersearch course project.
- Once genuine run-1 evidence exists (`reports/run1.md`, `traces/run1.jsonl`, and the `NYUgrader` tracker history), never delete or reset it. Database migrations from now on are additive only. Assignment 2 evidence uses new names (`reports/a2-run1.md`, `traces/a2-run1/`) and gets the same protection once it exists.

## Secrets

- `backend/.env` is local and ignored. Never commit environment credentials; keep only placeholder `.env.example` files in Git.
- Model and search keys (`GROQ_API_KEY`, `TAVILY_API_KEY`) and service tokens (`RESEARCHER_TOKEN`, `VERIFIER_TOKEN`) live only in the ignored `backend/.env.local`. The deployed verifier's token and model key live only in Render's environment settings.
- Never print, log, trace, or export passwords, tokens, or keys.

## Cirilio

- `/Users/stefanedelman/Desktop/cirilio` is a separate project. Read it for conventions only. Never modify it and never reuse its database, keys, branding, or business logic.
