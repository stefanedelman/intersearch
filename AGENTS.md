# Agent rules for Intersearch

Intersearch is a personal internship research dashboard built for NYU FNMS Assignment 1 and 1B. `INTERSEARCH_PLAN.md` is the build specification; read it before changing anything.

## Git

- Never stage, commit, or push. The user stages and commits their own changes unless they explicitly authorize otherwise for a specific operation.
- Do not rewrite history or change remotes without asking.

## Stack (matches Cirilio)

- TypeScript everywhere; Node `>=22.13`.
- Frontend: Vue 3, Vue Router, Vite, plain CSS. The frontend calls only our Express API and never imports `@supabase/supabase-js`.
- Backend: Express 5, Prisma 7 with `@prisma/adapter-pg`, Supabase PostgreSQL, Supabase Auth through a server-only service-role client.
- Tracker agent: hand-written loop in `backend/src/tracker`. No agent frameworks. Tracker modules never import Prisma; they persist only through the Express API.
- Zod for validating environment, config, requests, tool calls, and reports.

## Greenfield rules

- No existing users or data to preserve. Replace earlier schemas, components, and interfaces outright; no compatibility layers or feature flags.
- Development database resets are allowed only against the dedicated Intersearch course project.
- Once genuine run-1 evidence exists (`reports/run1.md`, `traces/run1.jsonl`, and the `NYUgrader` tracker history), never delete or reset it.

## Secrets

- `backend/.env` is local and ignored. Never commit environment credentials; keep only placeholder `.env.example` files in Git.
- Model and search keys (`GROQ_API_KEY`, `TAVILY_API_KEY`) live only in the ignored `backend/.env.local`.
- Never print, log, trace, or export passwords, tokens, or keys.

## Cirilio

- `/Users/stefanedelman/Desktop/cirilio` is a separate project. Read it for conventions only. Never modify it and never reuse its database, keys, branding, or business logic.
