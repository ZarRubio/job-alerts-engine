#!/usr/bin/env python3
"""Job alerts: search the portal CLIs, score deterministically, notify new fits.

Built for an unattended run (the .github/workflows/job-alerts.yml schedule,
twice a day): no LLM, stdlib only. One run:

  1. runs every enabled portal CLI `search` for every query in
     job_scraper/alert_config.json - or the portal's own `queries`, or one
     query-less call for a `single_call` portal (a failed call is logged and
     skipped);
  2. drops postings already alerted (job_scraper/alerts_state.json), already
     in /scrape's history (job_scraper/seen_jobs.json) or already in the
     tracker (job_search_tracker.csv), and collapses mass postings (same
     company, near-identical title) into one alert with a count;
  3. scores each posting 0-100 from the title, plus the description for the
     best candidates (portal `detail`, capped per run), using the rules in
     the config, and keeps the high and medium fits;
  4. sends one email (SMTP over SSL) - plus, optionally, short WhatsApp
     messages via CallMeBot - each channel only when its environment
     variables are set (see CHANNELS to add another provider);
  5. records the alerted postings in alerts_state.json - only after the
     notifications were attempted, so a crash never swallows an alert.

Secrets come only from the environment and are never printed:
  ALERT_SMTP_USER, ALERT_SMTP_APP_PASSWORD, ALERT_EMAIL_TO
  [ALERT_SMTP_HOST=smtp.gmail.com] [ALERT_SMTP_PORT=465]
  CALLMEBOT_PHONE, CALLMEBOT_APIKEY   (optional WhatsApp channel, inert unless set)

Usage:
  python3 tools/job_alerts.py [--dry-run] [--no-notify] [--config PATH]
                              [--state PATH] [--max-details N]
  python3 tools/job_alerts.py --test-notify

stdout is one compact JSON summary. Exit 0 on a completed run; 1 when bun is
missing, the config is unreadable, or --test-notify reached no channel; 2 when
there were alerts but no notification channel is configured (state is then
left untouched, so the next run retries them).
"""

from __future__ import annotations

import argparse
import json
import os
import smtplib  # noqa: F401  patched by tests
import sys
import time  # noqa: F401  patched by tests
import urllib.error  # noqa: F401
import urllib.request  # noqa: F401
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path
from typing import Any

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from alerting import notify as notify_mod  # noqa: E402,F401
from alerting import search  # noqa: E402,F401
from alerting.common import (  # noqa: E402,F401  re-exported for callers and tests
    ALERTS_STATE,
    CALLMEBOT_URL,
    CLI_TIMEOUT,
    COLLAPSE_RATIO,
    CONFIG,
    FIT_ICON,
    FIT_LABEL,
    FIT_RANK,
    OR_MAX,
    SKILLS,
    WHATSAPP_MAX_ENCODED,
    log,
)
from alerting.notify import (  # noqa: E402,F401  re-exported for callers and tests
    CHANNELS,
    _line_notes,
    configured_channels,
    email_bodies,
    email_channel,
    notify,
    redact,
    secrets,
    send_email,
    send_whatsapp,
    short_url,
    stack_line,
    subject_line,
    whatsapp_channel,
    whatsapp_messages,
)
from alerting.scoring import (  # noqa: E402,F401  re-exported for callers and tests
    Scorer,
)
from alerting.search import (  # noqa: E402,F401  re-exported for callers and tests
    build_calls,
    collapse,
    collapse_title,
    enrich_details,
    filter_known,
    find_bun,
    normalise_hit,
    portal_label,
    portal_queries,
    run_cli,
    search_all,
)
from alerting.state import (  # noqa: E402,F401  re-exported for callers and tests
    CORPUS_FIELDS,
    LEGAL_SUFFIXES,
    company_core,
    load_alerts,
    load_config,
    load_seen,
    load_tracker,
    prune_alerts,
    write_corpus,
)
from job_key import make_key  # noqa: E402
from rank_state import STATE as SEEN_STATE  # noqa: E402
from rank_state import TRACKER, norm, save_state  # noqa: E402,F401


def lima_now(config: dict) -> datetime:
    return datetime.now(timezone(timedelta(hours=config.get("timezone_offset_hours", -5))))


def compact(job: dict) -> dict:
    return {
        "key": job["key"],
        "fit": job["fit"],
        "score": job["score"],
        "title": job["title"],
        "company": job["company"],
        "location": job["location"],
        "date": job.get("date"),
        "portal": job["portal"],
        "source": job.get("source") or portal_label(job["portal"]),
        "url": short_url(job),
        "count": job.get("count", 1),
        "flags": job["flags"],
        "reasons": job["reasons"],
        "penalties": job["penalties"],
        "about": job.get("about") or "",
        "stack": stack_line(job),
    }


def run(args, env) -> tuple[int, dict]:
    if args.collect:
        args.dry_run = True
    summary: dict[str, Any] = {
        "mode": "collect"
        if args.collect
        else "dry-run"
        if args.dry_run
        else ("no-notify" if args.no_notify else "live"),
        "errors": [],
    }
    errors = summary["errors"]
    config = load_config(args.config)
    now = lima_now(config)

    if args.test_notify:
        summary["mode"] = "test-notify"
        when = now.strftime("%d/%m %H:%M")
        text = f"✅ Prueba de alertas de empleo — {when}. Si lees esto, el canal funciona."
        html = f"<html><body><p>{escape(text)}</p></body></html>"
        payload = {
            "subject": f"✅ Prueba de alertas de empleo — {when}",
            "text": text,
            "html": html,
            "short": [text],
            "delay": 0,
        }
        summary["channels"] = notify(env, payload, errors)
        sent = any(v.startswith("sent") for v in summary["channels"].values())
        return (0 if sent else 1), summary

    bun = find_bun(env)
    if bun is None:
        raise ValueError(
            "bun not found on PATH (needed to run the portal CLIs). Install it "
            "(https://bun.sh) or add it to PATH, then re-run."
        )

    doc = load_alerts(args.state)
    pruned = prune_alerts(doc, now.date(), int(config.get("prune_days", 60)))
    hits, search_stats = search_all(config, bun, errors)
    if args.collect:
        # Evaluation corpus: keep already-seen postings too, only collapse duplicates.
        for hit in hits:
            hit["key"] = make_key(hit["company"], hit["title"], hit["url"])
        fresh, skipped = collapse(hits), dict[str, int]()
    else:
        fresh, skipped = filter_known(hits, doc["alerts"], load_seen(args.seen), load_tracker(args.tracker))

    scorer = Scorer(config["scoring"], config["portals"])
    for job in fresh:
        job["fit_info"] = scorer.score(job)
    max_details = args.max_details if args.max_details is not None else int(config.get("max_details", 15))
    detail_stats = enrich_details(fresh, config, bun, scorer, max_details, errors)
    live = [j for j in fresh if not j.get("inactive")]
    for job in live:
        job.update(job.pop("fit_info"))

    counts = {"high": 0, "medium": 0, "low": 0, "excluded": 0}
    by_portal: dict = {}
    for job in live:
        bucket = "excluded" if job["excluded"] else job["fit"]
        counts[bucket] += 1
        per = by_portal.setdefault(job["portal"], {"high": 0, "medium": 0, "low": 0, "excluded": 0})
        per[bucket] += 1
    alerts = [j for j in live if j["fit"] in ("high", "medium")]
    alerts.sort(key=lambda j: j["score"], reverse=True)
    alerts.sort(key=lambda j: j.get("date") or "", reverse=True)
    alerts.sort(key=lambda j: FIT_RANK[j["fit"]])

    summary.update(
        {
            "searched": search_stats,
            "unique_hits": len(hits),
            "new_candidates": len(fresh),
            "skipped": {**skipped, "inactive": detail_stats["inactive"]},
            "details_fetched": detail_stats["details_fetched"],
            "counts": counts,
            "counts_by_portal": by_portal,
            "pruned": pruned,
            "alerted": [],
            "channels": {},
            "hits": [compact(j) for j in alerts],
        }
    )

    if args.collect:
        write_corpus(args.collect, live)
        summary["collected"] = len(live)
        return 0, summary
    if args.dry_run:
        lows = sorted((j for j in live if j not in alerts), key=lambda j: j["score"], reverse=True)[:5]
        summary["top_low"] = [compact(j) for j in lows]
        for job in alerts + lows:
            log(
                f"[{job['fit']:6} {job['score']:3}] {job['title']} — {job['company']} "
                f"({job.get('source') or job['portal']}) | {', '.join(job['flags'])}"
            )
        return 0, summary
    if not alerts:
        if pruned:
            save_state(args.state, doc)
        return 0, summary

    if args.no_notify:
        summary["channels"] = {"email": "disabled", "whatsapp": "disabled"}
    else:
        if not configured_channels(env):
            for channel in CHANNELS:
                log(f"{channel['name']} skipped: {channel['missing']}")
            errors.append("no notification channel configured; alerts kept for the next run")
            log(errors[-1])
            summary["channels"] = {"email": "skipped", "whatsapp": "skipped"}
            return 2, summary
        text, html = email_bodies(alerts, now)
        wa = whatsapp_messages(
            alerts,
            int(config.get("whatsapp_top", 5)),
            now,
            int(config.get("whatsapp_max_encoded_chars", WHATSAPP_MAX_ENCODED)),
        )
        payload = {
            "subject": subject_line(alerts, now),
            "text": text,
            "html": html,
            "short": wa,
            "delay": float(config.get("whatsapp_delay_seconds", 4)),
        }
        summary["channels"] = notify(env, payload, errors)

    today = now.date().isoformat()
    for job in alerts:
        for key in job["member_keys"]:
            entry = {
                "url": job["url"] if key == job["key"] else None,
                "title": job["title"],
                "company": job["company"],
                "portal": job["portal"],
                "fit": job["fit"],
                "score": job["score"],
                "first_alerted": today,
            }
            if key == job["key"] and job.get("count", 1) > 1:
                entry["count"] = job["count"]
            if key != job["key"]:
                entry["collapsed_into"] = job["key"]
                entry.pop("url")
            doc["alerts"][key] = entry
        summary["alerted"].append(job["key"])
    doc["updated"] = now.isoformat(timespec="seconds")
    Path(args.state).parent.mkdir(parents=True, exist_ok=True)
    save_state(Path(args.state), doc)
    return 0, summary


def _force_utf8_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="search and score only: no notifications, no state write")
    ap.add_argument(
        "--no-notify", action="store_true", help="record new alerts in the state without sending (seed run)"
    )
    ap.add_argument("--test-notify", action="store_true", help="send one test message per configured channel and exit")
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--state", type=Path, default=ALERTS_STATE)
    ap.add_argument("--seen", type=Path, default=SEEN_STATE, help=argparse.SUPPRESS)
    ap.add_argument("--tracker", type=Path, default=TRACKER, help=argparse.SUPPRESS)
    ap.add_argument("--max-details", type=int, default=None, help="cap on portal detail calls this run")
    ap.add_argument(
        "--collect",
        type=Path,
        default=None,
        help="dry run that also keeps already-seen postings and appends them (with descriptions) "
        "to this JSONL file for tools/eval_alerts.py labelling",
    )
    return ap.parse_args(argv)


def main(argv=None, env=None) -> int:
    _force_utf8_output()
    args = parse_args(argv)
    env = os.environ if env is None else env
    try:
        code, summary = run(args, env)
    except ValueError as exc:
        log(redact(str(exc), env))
        print(json.dumps({"error": redact(str(exc), env)}, ensure_ascii=False))
        return 1
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
