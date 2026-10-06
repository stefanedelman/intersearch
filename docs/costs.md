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
| Groq, model `openai/gpt-oss-120b` | requests per minute / per day | 30 / 1,000 (free plan; headers confirm 1,000 RPD) | https://console.groq.com/docs/rate-limits, checked 2026-10-05 |
| Groq, model `openai/gpt-oss-120b` | tokens per minute / per day | 8,000 / 200,000 (free plan; headers confirm 8,000 TPM). TPM is charged at request time as prompt tokens + `max_completion_tokens`. | same |
| Tavily | credits per month | 1,000 (Researcher plan, from `GET /usage`; 0 used on 2026-10-05) | https://docs.tavily.com |
| Greenhouse Job Board API | none published; public GET | — | https://docs.greenhouse.io/job-board.html |

Groq list prices for `openai/gpt-oss-120b` (from `GET /models`, 2026-10-05): $0.15 per million input tokens, $0.60 per million output tokens. Use these for the paid-equivalent cost.

## Per-run usage (measured)

From the run-1 summary, or `node scripts/trace-stats.mjs traces/run1.jsonl`:

| Run | Model calls | Input tokens | Output tokens | Search credits | External requests | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| run 1 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| run 2 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## If run daily

- **Daily limits:** a daily run fits if one run's requests and tokens stay under the per-day limits. They reset each day and do not accumulate.
- **Monthly credits A, using c credits per run:** that supports `floor(A / c)` daily runs; the next one exceeds it.
- **Answer for AGENT.md section 5:** [first allowance to run out, and on which day of the cycle].
