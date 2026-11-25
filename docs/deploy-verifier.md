# Deploying the verifier on Render (free tier)

The verifier is the only Assignment 2 service that runs in the cloud. The API + orchestrator and the researcher run on the laptop. Settings live in [`render.yaml`](../render.yaml) (a Render Blueprint); this page is what you do by hand.

Checked locally before deploying (2026-11-25):
- **The build:** the production build (`npm run build:verifier`, then `node dist/verifier/server.js`) pulls in only `src/verifier`, `src/shared` and npm packages.
- **Memory:** about 160 MB at start and about 200 MB after a page fetch and extraction. The free tier allows 512 MB.
- **Smoke test:** `node scripts/smoke-verifier.mjs` passed 9 of 9 against a local production build with a real Groq key. The real `/verify` took 0.6 s and 399 tokens.

## 1. Push the code

Render builds from GitHub, so the verifier code must be committed and pushed: `backend/src/verifier`, `backend/src/shared`, `backend/package*.json`, `backend/tsconfig*.json` and `render.yaml`. Any branch works; you pick it in step 3.

## 2. A model key and model for the verifier

- **Key:** create a Groq API key for the verifier at <https://console.groq.com/keys>. A separate project or account is best: Groq's limits are per model and the free tier is small, so the verifier should not share the researcher's budget. Set a spend limit, or keep it on the unfunded free tier.
- **Model:** pick a Groq model id **different from the researcher's** (`config.yaml` → `model.id`) that supports JSON mode (`response_format: json_object`). The verifier sends one small call per development at temperature 0.

## 3. Create the service

1. Render dashboard → **New** → **Blueprint** → connect `stefanedelman/intersearch` → choose the branch.
2. Render reads `render.yaml` and creates `intersearch-verifier` on the free plan. When it asks for the three secret values, enter:
   - `VERIFIER_TOKEN`: the **same** value as in `backend/.env.local`. To copy it without displaying it, run this in the repo root:

     ```bash
     grep '^VERIFIER_TOKEN=' backend/.env.local | cut -d= -f2- | tr -d '\n' | pbcopy
     ```

   - `VERIFIER_GROQ_API_KEY`: the key from step 2.
   - `VERIFIER_MODEL`: the model id from step 2.
3. Wait for the first deploy to go live (build: `npm ci --include=dev && npm run build:verifier`; start: `node dist/verifier/server.js`; health check `/healthz`).

These values exist only in Render's environment settings, never in the repo.

## 4. Point the API at it

Put the service URL in `backend/.env` (not secret):

```text
VERIFIER_URL=https://intersearch-verifier.onrender.com
```

Use the exact URL Render shows. Restart the API, or use `npm run dev:all -- --remote-verifier`. The dashboard's Verifier chip should turn green.

## 5. Smoke test and cold start

Run this from the repo root. It reads `VERIFIER_URL` and the token from your env files and never prints the token:

```bash
node scripts/smoke-verifier.mjs
```

Expect 9/9.

For the cold-start number (`docs/costs.md` and `ORCHESTRATION.md` question 2), wait at least 15 minutes without calling the verifier, then run:

```bash
node scripts/smoke-verifier.mjs --save
```

The first line's time is the cold start. `--save` appends the table to `docs/verifier-smoke.md`.

## What lives where

| Setting | Where |
| --- | --- |
| `VERIFIER_TOKEN` | Render env **and** `backend/.env.local` (same value) |
| `VERIFIER_GROQ_API_KEY`, `VERIFIER_MODEL` | Render env only (and `backend/.env.local` only if you also run a local verifier) |
| `VERIFIER_URL` | `backend/.env` |
| `APP_ENV=production`, `NODE_VERSION=22` | `render.yaml` |

Traces: in production the verifier writes its JSONL trace lines to stdout, so they appear in Render's **Logs** tab. The orchestrator also pulls each run's lines with `GET /trace?run_id=` right after the run, into `runs/<runId>/verifier.jsonl`, because the in-memory copy is lost when the free instance sleeps.
