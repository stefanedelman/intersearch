# Sources and fetch permissions

Checked on **2026-09-28**. The tracker fetches only the exact hosts in `config.yaml` → `fetch_policy.allowed_hosts`. It never fetches anything behind a login, CAPTCHA, or paywall.

## Companies

All five companies publish their jobs through Greenhouse's public [Job Board API](https://docs.greenhouse.io/job-board.html). That API is meant for public consumption and needs no key. Each board had at least one summer 2027 software-engineering internship listing a New York office when checked.

| Company | Board token | Posting URLs point to | Example internship seen 2026-09-28 |
| --- | --- | --- | --- |
| Datadog | `datadog` | `careers.datadoghq.com` | Software Engineering Intern (Summer), Boston / New York (job 8052118) |
| Stripe | `stripe` | `stripe.com` | Software Engineer, Intern (Summer or Winter), San Francisco / Seattle / New York City (job 8128745) |
| Figma | `figma` | `boards.greenhouse.io` → `job-boards.greenhouse.io` | Software Engineer Intern (Summer 2027), San Francisco / New York (job 6143238004) |
| Robinhood | `robinhood` | `boards.greenhouse.io` | Software Engineering Intern, Backend (Summer 2027), Bellevue / Menlo Park / New York (job 8123225) |
| Duolingo | `duolingo` | `careers.duolingo.com` | Software Engineer, Intern, New York / Pittsburgh / Seattle (job 8805925002) |

## robots.txt checks (2026-09-28)

| Host | Result |
| --- | --- |
| `boards-api.greenhouse.io` | `Disallow: /embed/` only; `/v1/boards/...` is allowed |
| `boards.greenhouse.io` | `Disallow: /embed/` only |
| `job-boards.greenhouse.io` | no rules in effect (the file's disallow lines are commented out) |
| `stripe.com` | disallows `/docs`, some `/sources/...` paths, and `/handoff`; `/jobs` and `/careers` are allowed |
| `careers.datadoghq.com` | robots.txt lists only a sitemap; no disallow rules |
| `careers.duolingo.com` | no robots.txt (the path serves the site's HTML page), so no rules |

## Notes

- The fetcher identifies itself with the user agent `IntersearchBot/0.1 (NYU FNMS course project; fetches a few allowlisted public job pages per run)`.
- robots.txt is checked by hand when a host is added (the table above), not fetched at runtime; hosts outside the allowlist are never fetched.
- Load is small: one feed request per company per run, plus up to `max_fetches` posting pages.
- Some boards return JSON with raw control characters inside strings. The feed parser tolerates this (`parseLenientJson`).
- Stripe and Datadog careers-site pages are server-rendered, so their text is extractable. Duolingo's job description is mostly outside the API's `content` field, so its extracted facts are sparse and it ranks lower. That is honest missing data, not an error.
- Terms and robots rules can change. Re-check this page before relying on a new source, and record the date.
