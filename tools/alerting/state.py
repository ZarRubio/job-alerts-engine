"""Config and state files: alert history, seen jobs, tracker, evaluation corpus."""

from __future__ import annotations

import json
import os
from datetime import date, timedelta
from pathlib import Path

from alerting.common import log
from rank_state import load_state, tracker_pairs


def deep_merge(base: dict, overlay: dict) -> dict:
    """Overlay wins; nested objects merge key by key, lists and scalars replace."""
    merged = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _read_json(path: Path, what: str) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {what} {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{what} {path} must be a JSON object")
    return data


def load_config(path: Path, profile: Path | None = None) -> dict:
    """Generic rules (alert_config.json) with the candidate profile merged over them.

    The profile is `profile` if given, else $JOB_ALERTS_PROFILE, else the config's
    `profile_file` (resolved next to the config). A config without one is used as is.
    """
    config = _read_json(path, "config")
    explicit = profile or os.environ.get("JOB_ALERTS_PROFILE")
    if explicit:
        config = deep_merge(config, _read_json(Path(explicit), "profile"))
    elif config.get("profile_file"):
        config = deep_merge(config, _read_json(Path(path).parent / config["profile_file"], "profile"))
    if not isinstance(config.get("queries"), dict):
        raise ValueError(f"config {path} needs a 'queries' object")
    if not isinstance(config.get("portals"), dict) or not isinstance(config.get("scoring"), dict):
        raise ValueError(f"config {path} needs 'portals' and 'scoring' objects")
    return config


def load_alerts(path: Path) -> dict:
    if not Path(path).is_file():
        return {"version": 1, "alerts": {}}
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read alerts state {path}: {exc}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("alerts"), dict):
        raise ValueError(f"alerts state {path} needs an 'alerts' object")
    return doc


def prune_alerts(doc: dict, today: date, days: int) -> int:
    cutoff = today - timedelta(days=days)
    stale = []
    for key, entry in doc["alerts"].items():
        try:
            first = date.fromisoformat(str((entry or {}).get("first_alerted")))
        except ValueError:
            continue  # unknown date: keep rather than re-alert
        if first < cutoff:
            stale.append(key)
    for key in stale:
        del doc["alerts"][key]
    return len(stale)


def load_seen(path: Path) -> dict:
    """/scrape's history, when this checkout has one (it is gitignored)."""
    if not Path(path).is_file():
        return {}
    try:
        _, seen = load_state(Path(path))
    except SystemExit as exc:  # load_state exits on a corrupt file
        log(f"ignoring seen_jobs history: {exc}")
        return {}
    return {k: v for k, v in seen.items() if isinstance(v, dict)}


def load_tracker(path: Path) -> set:
    try:
        return tracker_pairs(Path(path))
    except SystemExit as exc:
        log(f"ignoring tracker: {exc}")
        return set()


LEGAL_SUFFIXES = (
    "ltd",
    "limited",
    "inc",
    "corp",
    "corporation",
    "llc",
    "sac",
    "saa",
    "sa",
    "srl",
    "eirl",
    "gmbh",
    "plc",
    "group",
    "grupo",
    "peru",
    "perú",
    "latam",
    "digital",
)


def company_core(normed: str) -> str:
    """Strip trailing legal/region suffixes from an already-normalised company name."""
    changed = True
    while changed:
        changed = False
        for suffix in LEGAL_SUFFIXES:
            if normed.endswith(suffix) and len(normed) > len(suffix) + 2:
                normed, changed = normed[: -len(suffix)], True
    return normed


CORPUS_FIELDS = ("key", "portal", "title", "company", "location", "date", "url", "description")


def write_corpus(path: Path, jobs: list[dict]) -> int:
    """Append postings not yet in the JSONL corpus (by key); never touches existing labels."""
    path = Path(path)
    known = set()
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                known.add(json.loads(line).get("key"))
    added = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        for job in jobs:
            if job["key"] in known:
                continue
            row = {f: job.get(f) for f in CORPUS_FIELDS}
            row["label"] = None
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            known.add(job["key"])
            added += 1
    return added
