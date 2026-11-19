"""Portal search: run the portal CLIs, normalise, dedupe and enrich postings."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import scrape_state
from alerting.common import CLI_TIMEOUT, COLLAPSE_RATIO, OR_MAX, ROOT, SKILLS, log
from alerting.scoring import Scorer
from alerting.state import company_core
from job_key import make_key
from rank_state import norm


def find_bun(env) -> str | None:
    found = shutil.which("bun")
    if found:
        return found
    home = Path(env.get("BUN_INSTALL") or Path.home() / ".bun") / "bin"
    for name in ("bun", "bun.exe"):
        if (home / name).is_file():
            return str(home / name)
    return None


def run_cli(bun: str, portal: str, argv: list) -> dict:
    """Run one portal CLI command and return its parsed JSON (raises on failure)."""
    cli = SKILLS / portal / "cli" / "src" / "cli.ts"
    if not cli.is_file():
        raise RuntimeError(f"{portal}: CLI not found at {cli.relative_to(ROOT)}")
    proc = subprocess.run(
        [bun, "run", str(cli), *argv],
        cwd=str(ROOT),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=CLI_TIMEOUT,
    )
    if proc.returncode != 0:
        detail = " ".join((proc.stderr or "").split())[:300]
        raise RuntimeError(f"{portal} {argv[0]} exited {proc.returncode}: {detail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{portal} {argv[0]} printed invalid JSON: {exc}") from exc


def portal_queries(config: dict, settings: dict) -> dict:
    """The {category: [query, ...]} one portal searches.

    Default: the global `queries`. A portal may narrow that with
    `query_categories` (a subset of the global category names) or replace it
    with its own `queries` (a list, filed under category "portal", or a
    {category: [...]} object) - for an API with a tight rate limit, where a
    short keyword list beats one call per global term.
    """
    own = settings.get("queries")
    if isinstance(own, list):
        return {"portal": own}
    if isinstance(own, dict):
        return own
    queries = config["queries"]
    wanted = settings.get("query_categories")
    if isinstance(wanted, list):
        return {c: q for c, q in queries.items() if c in wanted}
    return queries


def build_calls(config: dict) -> list[dict]:
    calls = []
    for portal, settings in config["portals"].items():
        if not isinstance(settings, dict) or not settings.get("enabled", True):
            continue
        extra = []
        for flag, value in (settings.get("search_args") or {}).items():
            extra += [flag] if value is True else [flag, str(value)]
        if settings.get("single_call"):
            # One query-less call (a whole category/country feed): the API asks
            # for few requests and the scorer does the keyword filtering.
            calls.append(
                {
                    "portal": portal,
                    "category": "general",
                    "query": "(sin consulta)",
                    "argv": ["search", *extra, "--format", "json"],
                }
            )
            continue
        for category, queries in portal_queries(config, settings).items():
            queries = [q for q in queries if isinstance(q, str) and q.strip()]
            if settings.get("combine_with_or"):
                groups = [" OR ".join(queries[i : i + OR_MAX]) for i in range(0, len(queries), OR_MAX)]
            else:
                groups = queries
            for query in groups:
                calls.append(
                    {
                        "portal": portal,
                        "category": category,
                        "query": query,
                        "argv": ["search", "--query", query, *extra, "--format", "json"],
                    }
                )
    return calls


def portal_label(portal: str, config: dict | None = None) -> str:
    """Human name of a portal for the alert ("getonbrd-search" -> "Getonbrd")."""
    settings = ((config or {}).get("portals") or {}).get(portal) or {}
    if isinstance(settings, dict) and settings.get("label"):
        return str(settings["label"])
    return portal.removesuffix("-search").replace("-", " ").title()


def normalise_hit(raw: dict, portal: str, category: str, config: dict | None = None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    title, company, url = (str(raw.get(f) or "").strip() for f in ("title", "company", "url"))
    if not (title and company and url.startswith(("http://", "https://"))):
        return None
    # Attribution: Remotive and Himalayas require naming them as the source,
    # and the alert shows it for every portal.
    source = str(raw.get("source") or "").strip() or portal_label(portal, config)
    return {
        "portal": portal,
        "source": source,
        "id": str(raw.get("id") or ""),
        "title": " ".join(title.split()),
        "company": " ".join(company.split()),
        "location": str(raw.get("location") or ""),
        "date": raw.get("date") if isinstance(raw.get("date"), str) else None,
        "url": url,
        "description": raw.get("description") if isinstance(raw.get("description"), str) else None,
        "categories": [category],
        "count": 1,
    }


def search_all(config: dict, bun: str, errors: list) -> tuple[list[dict], dict]:
    hits: list[dict] = []
    by_url: dict[str, dict] = {}
    stats: dict[str, Any] = {"calls": 0, "failed": 0, "raw_hits": 0, "by_portal": {}}
    last_portal = None
    for call in build_calls(config):
        delay = float(config["portals"][call["portal"]].get("delay_seconds") or 0)
        if last_portal == call["portal"] and delay > 0:
            time.sleep(delay)
        last_portal = call["portal"]
        stats["calls"] += 1
        per = stats["by_portal"].setdefault(call["portal"], {"calls": 0, "failed": 0, "raw_hits": 0})
        per["calls"] += 1
        try:
            data = run_cli(bun, call["portal"], call["argv"])
        except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
            stats["failed"] += 1
            per["failed"] += 1
            message = f"search {call['portal']} '{call['query']}': {exc}"
            errors.append(message)
            log(message)
            continue
        results = data.get("results") if isinstance(data, dict) else data
        for raw in results if isinstance(results, list) else []:
            hit = normalise_hit(raw, call["portal"], call["category"], config)
            if hit is None:
                continue
            stats["raw_hits"] += 1
            per["raw_hits"] += 1
            url_key = hit["url"].rstrip("/")
            if url_key in by_url:
                known = by_url[url_key]
                if call["category"] not in known["categories"]:
                    known["categories"].append(call["category"])
                continue
            by_url[url_key] = hit
            hits.append(hit)
    return hits, stats


def collapse_title(title: str) -> str:
    text = unicodedata.normalize("NFKD", title.casefold())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"ref\s*#?\s*\d+", " ", text)
    text = re.sub(r"[^a-z]+", " ", text)
    return " ".join(text.split())


def collapse(jobs: list[dict]) -> list[dict]:
    """Same company + near-identical title in one run -> one alert with a count."""
    groups: list[dict] = []
    for job in jobs:
        company, title = norm(job["company"]), collapse_title(job["title"])
        for group in groups:
            if group["_company"] != company:
                continue
            if group["_title"] == title or SequenceMatcher(None, group["_title"], title).ratio() >= COLLAPSE_RATIO:
                group["members"].append(job)
                break
        else:
            groups.append({"_company": company, "_title": title, "members": [job]})
    reps = []
    for group in groups:
        members = sorted(group["members"], key=lambda j: j.get("date") or "", reverse=True)
        rep = dict(members[0])
        rep["count"] = len(members)
        rep["member_keys"] = [m["key"] for m in members]
        reps.append(rep)
    return reps


def filter_known(hits: list[dict], alerts: dict, seen: dict, tracker: set) -> tuple[list[dict], dict]:
    alerted_urls = {str(e.get("url") or "").rstrip("/") for e in alerts.values() if isinstance(e, dict)}
    fresh, skipped = [], {"already_alerted": 0, "already_seen": 0, "already_applied": 0, "collapsed": 0}
    for hit in hits:
        hit["key"] = make_key(hit["company"], hit["title"], hit["url"])
        if hit["key"] in alerts or hit["url"].rstrip("/") in alerted_urls:
            skipped["already_alerted"] += 1
        else:
            fresh.append(hit)
    reps = collapse(fresh)
    skipped["collapsed"] = len(fresh) - len(reps)
    try:
        selected, counts = scrape_state.select(reps, seen, tracker)
    except ValueError as exc:
        log(f"ignoring seen_jobs history: {exc}")
        selected, counts = scrape_state.select(reps, {}, tracker)
    skipped["already_seen"] = counts["already_seen"]
    skipped["already_applied"] = counts["already_applied"]
    # "Costanera Ltd" in a portal and "Costanera" in the tracker are the same employer.
    applied = {(company_core(c), r) for c, r in tracker}
    kept = [h for h in selected if (company_core(norm(h["company"])), norm(h["title"])) not in applied]
    skipped["already_applied"] += len(selected) - len(kept)
    return kept, skipped


def enrich_details(jobs: list[dict], config: dict, bun: str, scorer: Scorer, limit: int, errors: list) -> dict:
    """Fetch descriptions for the best title-only candidates; drop closed LinkedIn ones."""
    stats = {"details_fetched": 0, "inactive": 0}
    pool = [
        j
        for j in jobs
        if not j.get("description")
        and (config["portals"].get(j["portal"]) or {}).get("detail")
        and not j["fit_info"]["non_tech"]
        and not j["fit_info"]["excluded"]
    ]
    pool.sort(key=lambda j: j["fit_info"]["score"], reverse=True)
    for job in pool[: max(0, limit)]:
        if stats["details_fetched"]:
            time.sleep(float(config["portals"][job["portal"]].get("delay_seconds") or 0))
        stats["details_fetched"] += 1
        try:
            data = run_cli(bun, job["portal"], ["detail", job["id"] or job["url"], "--format", "json"])
        except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
            message = f"detail {job['portal']} {job['id']}: {exc}"
            errors.append(message)
            log(message)
            continue
        if not isinstance(data, dict):
            continue
        if data.get("isActive") is False:
            job["inactive"] = True
            stats["inactive"] += 1
            continue
        if isinstance(data.get("description"), str):
            job["description"] = data["description"]
        if isinstance(data.get("location"), str) and data["location"].strip():
            job["location"] = data["location"]
        job["fit_info"] = scorer.score(job)
    return stats
