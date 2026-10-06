# Costs and provider limits

Nothing here comes from memory. Fill in each value from the provider's own page on the day you set up keys, and record that date.

## Hard caps (set before the first request)

| Provider | Plan | Hard spend cap | Verified on |
| --- | --- | --- | --- |
| Groq | Free | Free tier has no billing, so nothing can be charged. Confirmed by response headers matching free-plan limits (1,000 RPD, 8,000 TPM). | 2026-10-05 |
| Tavily | Researcher (free) | Free credits only: `GET /usage` reports `paygo_usage: 0`, no PayGo limit, and no per-key limit. The config caps search at 4 credits per run. | 2026-10-05 |

A notification threshold is not a hard cap. If a provider can't enforce a cap, use its unfunded free tier.

## Free allowances

| Provider | Limit | Value | Source |
| --- | --- | --- | --- |
| Groq, model `qwen/qwen3.8-27b` | requests per minute / per day | 30 / 1,000 (free plan; headers confirm 1,000 RPD) | https://console.groq.com/docs/rate-limits, checked 2026-10-05 |
| Groq, model `qwen/qwen3.8-27b` | tokens per minute / per day | 8,000 / 200,000 (free plan; headers confirm 8,000 TPM; limits are per model). TPM is charged at request time as prompt tokens + `max_completion_tokens`. | same |
| Tavily | credits per month | 1,000 (Researcher plan, from `GET /usage`; 0 used on 2026-10-05) | https://docs.tavily.com |
| Greenhouse Job Board API | none published; public GET | — | https://docs.greenhouse.io/job-board.html |

Groq list prices for `qwen/qwen3.8-27b` (from `GET /models`, 2026-10-05): $0.80 per million input tokens, $4.00 per million output tokens. Use these for the paid-equivalent cost.

## Per-run usage (measured)

From the run-1 summary, or `node scripts/trace-stats.mjs traces/run1.jsonl`:

| Run | Model calls | Input tokens | Output tokens | Search credits | External requests | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| run 1 (`255a44ee`, `qwen/qwen3.8-27b`) | 14 | 47,233 | 1,115 | 0 | 19 (14 Groq + 5 Greenhouse) | 355 s |
| run 2 | not captured | | | | | |

## If run daily

- **Daily limits:** a daily run fits if one run's requests and tokens stay under the per-day limits. They reset each day and do not accumulate.
- **Monthly credits A, using c credits per run:** that supports `floor(A / c)` daily runs; the next one exceeds it.
- **Answer for AGENT.md section 5:** at one run per day, no free allowance runs out. Groq's 200K tokens/day per model fits about 4 runs (we hit it on the fourth `gpt-oss-20b` run on 2026-10-05). Tavily used 0 credits in run 1, and at most 4 per run would last 250 runs, which is more than a month. The binding limit is Groq's 8K tokens/minute, which spaces calls about 25–40 s apart.
