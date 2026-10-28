# 13 · Use cases

The engine fits any work that runs in steps, produces drafts a person judges, and reuses the same reference material each time.

## Content creation

| Use case | Notes |
|---|---|
| **Mohalla Mitra motion comics** (reference) | Story → shots → panels → clips → voices → music → Reel. See [14](14-mohalla-mitra.md) |
| **100 faceless Instagram channels** | High volume, many projects in parallel, little human review; needs batching, per-project costs, high trust levels |
| **Store promos / product ads** | Short pipeline; brand assets as the Library |
| **Cooking reels, explainers** | Template-driven; "describe it" authoring |

## Beyond content

| Use case | Levels | Agents do | Human decides | Assets reused | Goes stale when |
|---|---|---|---|---|---|
| Permit and license review (government) | Program, application, review step | Extract documents, check completeness, draft findings and letters | Caseworker approves, requests info or denies | Regulations, fee schedules, letter templates | A rule or fee changes mid-review |
| Case investigation | Case, lead, evidence item | Summarize evidence, link entities, draft reports | Investigator picks leads, locks findings | Policies, report formats, prior cases | New evidence changes a locked finding |
| Hiring | Role, candidate, stage | Screen applications, draft questions, summarize interviews | Shortlist, offer approval | Job description, rubric, offer template | Role requirements change |
| Job applications | Search, company, application | Tailor resume, draft cover letter, research the company | Pick a version, submit | Master resume, stories bank, tone | Master resume is updated |
| Store pricing | Store, vendor update, product | Read vendor sheets, compute margins, draft promo posts | Approve prices before they go to delivery apps | Margin targets, brand style, platform rules | A vendor's cost changes |
| Investment research | Watchlist, quarter, company | Read earnings reports, score against a thesis, rank | Pick names to act on | Thesis, scoring rules, past notes | A new filing or guidance lands |
| Consumer legal documents | Matter, document, clause | Intake, draft clauses, explain terms | Choose clause versions, sign off | Clause library, jurisdiction rules | An intake fact changes |
| Software feature delivery | Product, feature, task | Draft spec, write code, run tests, review | Approve spec, pick a design branch, merge | Architecture rules, style guide, test suites | The spec or an API changes |

Common thread: branches for alternatives, locks for decisions, stale tracking when an upstream fact changes, and a knowledge base that turns repeat mistakes into rules. **Government case work is the closest match outside content**, since it already runs on stages, human approvals and reusable rules.

## v0.1 proof

Two real use cases with different shapes, to prove the abstraction isn't one-off:
1. **Mohalla Mitra Part 3** — media-heavy, many human picks.
2. **Earnings report** — text-only: summarize each release (judged against it) → score against a thesis → write → read → rank the quarter. In [`examples/earnings-report`](../examples/earnings-report/README.md) (Day 33). Fetching the filings is still the creator's job.
