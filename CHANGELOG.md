# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-19

First public release.

### Added
- Alert pipeline: portal search, normalisation, dedupe (including mass postings),
  description fetch for the best candidates, email and optional WhatsApp delivery
  with secret redaction, state kept on an orphan `alerts-state` branch.
- Explainable scoring model: role from the title (grouped categories), stack
  coverage from the description (~100 technologies), location, language,
  seniority and gig-platform gates, a capped BI/data-analyst track.
- Evaluation: `job-alerts-eval` reports precision, recall, F1 and misclassified
  postings for a labelled corpus; `--collect` appends new postings for labelling.
  On 226 hand-labelled real postings F1 went from 0.72 (keyword baseline) to 0.90
  (tuned on the same corpus; hold-out evaluation pending).
- Portal CLIs (TypeScript/Bun) for Get on Board, Remotive and Himalayas.
- Packaging (`pip install -e .`, `job-alerts` and `job-alerts-eval` commands),
  `JOB_ALERTS_HOME` to point the tool at a project folder.
- CI: tests on Python 3.10/3.12/3.13, coverage gate (85%), ruff, mypy and the
  portal CLI tests; Dependabot for Actions, npm and pip.

[0.1.0]: https://github.com/ZarRubio/job-alerts-engine/releases/tag/v0.1.0
