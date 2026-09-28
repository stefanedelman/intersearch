# Costs and provider limits

Nothing here comes from memory. Fill in each value from the provider's own page on the day you set up keys, and record that date.

## Hard caps (set before the first request)

| Provider | Plan | Hard spend cap | Verified on |
| --- | --- | --- | --- |
| Groq | [free / paid] | [free tier has no billing, or the spend limit you set] | [date] |
| Tavily | [free / paid] | [free credits only, or the PayGo cap you set] | [date] |

A notification threshold is not a hard cap. If a provider can't enforce a cap, use its unfunded free tier.

## Free allowances

| Provider | Limit | Value | Source |
| --- | --- | --- | --- |
| Groq, model `llama-3.3-70b-versatile` | requests per minute / per day | [ ] / [ ] | https://console.groq.com/docs/rate-limits |
| Groq, model `llama-3.3-70b-versatile` | tokens per minute / per day | [ ] / [ ] | same |
| Tavily | credits per month | [ ] | https://docs.tavily.com |
| Greenhouse Job Board API | none published; public GET | — | https://docs.greenhouse.io/job-board.html |

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
