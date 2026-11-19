# Job Alerts Engine

[![CI](https://github.com/ZarRubio/job-alerts-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/ZarRubio/job-alerts-engine/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A585%25%20(gate)-brightgreen)
![python](https://img.shields.io/badge/python-3.10%2B-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

A personal job-alert pipeline that searches job boards twice a day, scores every new posting against a candidate profile and emails only the ones worth applying to, with a one-line summary of what each job is about and which parts of its stack the candidate already has.

I built it for my own search (full stack + applied AI roles in Lima, Peru, and remote LATAM) and **measured it against 226 real postings I labelled by hand**:

| Metric (alert = fit high or medium) | Keyword baseline | Current model |
|---|---|---|
| Precision | 61.5% | **86.0%** |
| Recall | 87.9% | **94.8%** |
| F1 | 0.72 | **0.90** |
| Precision of "high" alerts | 82.6% | **100%** |

> Honest caveat: the model was tuned on the same 226 postings it is scored on, so these numbers are optimistic. A hold-out evaluation on postings collected after tuning is the next step. The labelled corpus is not published because it contains third-party job descriptions; the evaluation tool and a small synthetic sample are.

## How it works

```mermaid
flowchart LR
    A[GitHub Actions<br/>schedule] --> B[Portal CLIs<br/>Get on Board · Remotive · Himalayas]
    B --> C[Normalise + dedupe<br/>collapse mass postings]
    C --> D[Skip already seen<br/>or applied]
    D --> E[Fetch descriptions<br/>for the best candidates]
    E --> F[Score]
    F --> G{high / medium?}
    G -- yes --> H[Email + optional WhatsApp]
    G -- no --> I[Dropped]
    H --> J[State branch<br/>alerts-state]
```

The score is deterministic (no LLM, no API cost) and every point is explained in the email:

- **Role, from the title.** Role categories (AI/LLM, full stack, analyst-developer, ERP, automation…) are grouped, so a title naming three of them counts once. Seniority, non-development tracks (QA, security, sales, product) and off-stack titles (COBOL, Go, React Native…) subtract.
- **Stack coverage, from the description.** ~100 technologies are classified as *have* (1), *partial* (0.5: declared, academic or learning) or *missing* (0). Coverage above or below a pivot adds or subtracts points, so a posting full of tools the candidate lacks sinks even with a good title.
- **Hard gates.** Relocation, another city without full remote (a Lima district beats a mislabelled region), a foreign-only location, another required language, or a gig-platform employer exclude the posting. Years of experience above a threshold subtract.
- **Special tracks.** BI / data-analyst postings alert only when they also ask for Python, automation or AI, and never above "medium", so they cannot crowd out development roles.

### Example alert (synthetic postings)

![Example alert email: a table with fit, score, title, company, what the job is about, the stack it asks for (have / partial / missing), source, location, warnings and the reasons behind the score](docs/email-example.png)

The alert text is in Spanish because the candidate searches in Peru; the code, config keys and docs are in English.

## Repository layout

| Path | What it is |
|---|---|
| `tools/job_alerts.py` | CLI: `--dry-run`, `--no-notify`, `--test-notify`, `--collect` |
| `tools/alerting/` | `search.py` (portal CLIs, dedupe, details), `scoring.py` (the model), `notify.py` (email/WhatsApp, secret redaction), `state.py`, `common.py` |
| `tools/eval_alerts.py` | Precision, recall, F1 and the misclassified postings for a labelled corpus |
| `job_scraper/alert_config.json` | Generic rules: portals, role and seniority rules, gates, thresholds |
| `job_scraper/profile.json` | The candidate: search queries, stack (have / partial / missing), home city and districts, years, English level. Merged over the rules |
| `portals/*/cli` | TypeScript/Bun CLIs for Get on Board, Remotive and Himalayas: `search`/`detail`, JSON output, backoff on 429/5xx, zero runtime dependencies, network-free tests |
| `examples/profile.example.json` | A second profile (Java backend developer in Bogotá) showing how to retarget the engine |
| `examples/sample_corpus.jsonl` | 12 synthetic labelled postings to try the evaluator |
| `docs/email-example.png` | The alert email above, rendered from the synthetic sample |
| `.github/workflows/` | `ci.yml` (tests, ruff, mypy, portal tests) and `job-alerts.yml` (the scheduled run) |

## Run it

Requirements: Python 3.10+ (no runtime dependencies) and [Bun](https://bun.sh) for the portal CLIs.

```bash
git clone https://github.com/ZarRubio/job-alerts-engine && cd job-alerts-engine
pip install -e ".[dev]"                                   # installs the job-alerts and job-alerts-eval commands
for d in portals/*/cli; do (cd "$d" && bun install); done

job-alerts --dry-run --max-details 5                      # search and score, print, send nothing
job-alerts-eval --corpus examples/sample_corpus.jsonl --errors
```

Config, state and portals are read from the repository checkout. To keep your own config and state elsewhere, point `JOB_ALERTS_HOME` at a folder with the same `job_scraper/` and `portals/` layout.

To get emails, set `ALERT_SMTP_USER`, `ALERT_SMTP_APP_PASSWORD` (a Gmail app password) and `ALERT_EMAIL_TO`, then run without `--dry-run`. In GitHub Actions they are repository secrets; the workflow keeps the "already alerted" state on an orphan `alerts-state` branch so nothing personal lands on `main`.

### Adapt it to your profile

Everything that depends on who is searching lives in `job_scraper/profile.json`; `alert_config.json` holds rules that work for anyone. To retarget the engine:

1. Copy `examples/profile.example.json` over `job_scraper/profile.json` (or set `JOB_ALERTS_PROFILE=/path/to/your-profile.json`).
2. Edit `queries`, the `stack` tiers (what you have, know partially or lack), `location` (home city, its districts, other cities, which countries count as home) and the `years` threshold.
3. Run `job-alerts --dry-run` and check the reasons in the output; label a few postings and run `job-alerts-eval` to see whether the change helped.

The profile is deep-merged over the rules: objects merge key by key, lists replace. A test scores the same posting under both profiles to prove a Bogotá job passes for the Bogotá profile and is excluded for the Lima one.

### Measuring a change

```bash
python tools/job_alerts.py --collect job_scraper/eval/corpus.jsonl --max-details 60  # append new postings, label: null
# label them (1 = worth an alert, 0 = not; "unsure": true for borderline cases)
python tools/eval_alerts.py --errors      # before and after editing alert_config.json
```

`tests/test_eval_alerts.py` enforces minimum precision, recall and F1 on the labelled corpus when it is present, so a tuning change that degrades the model fails CI.

## Design decisions

- **Deterministic first, not an LLM.** The filter runs twice a day over a few hundred postings. Rules cost nothing, run in seconds, never hallucinate a requirement and explain every point they give. An LLM re-ranking of the top results is a possible next layer, and it would have to beat the same labelled corpus to earn its cost.
- **Measured, not eyeballed.** Every tuning change is judged by precision, recall and F1 on hand-labelled real postings, and CI enforces minimum values so a regression cannot slip in unnoticed.
- **Tuning is configuration, and the person is separate from the rules.** Every pattern, weight and threshold lives in JSON; the code only interprets it. The candidate-specific part is its own file, so adapting the engine to someone else means editing `profile.json`, not Python.
- **Explainability over a single number.** The email shows why a posting scored what it did and which parts of its stack are covered, so the reader can disagree with the model in seconds.
- **Secrets and personal state stay out of git.** Credentials come from environment variables and are redacted from every log and message; the alert history lives on a separate orphan branch.

## Quality

- 54 Python tests (scoring cases, dedupe, notifications with mocked SMTP/HTTP and secret redaction, CLI runs with mocked portals, the evaluator, profile merging) plus Bun tests for each portal CLI. Coverage of the engine is ~87%, with an 85% gate in CI.
- `ruff` (lint + format) and `mypy` in CI; actions pinned to commit SHAs; checkout without persisted credentials; Dependabot for Actions, npm and pip.
- Versioned releases with a [changelog](CHANGELOG.md).

## How it was built

I designed it and directed the implementation with **Claude Code** (multi-agent: subagents with self-review loops), reviewing every change. The dedupe and state helpers (`tools/job_key.py`, `tools/rank_state.py`, `tools/scrape_state.py`) come from the open-source [ai-job-search](https://github.com/MadsLorentzen/ai-job-search) framework by Mads Lorentzen (MIT); the alert pipeline, scoring model, evaluation and the three portal CLIs are my additions.

## License

MIT, see [LICENSE](LICENSE).
