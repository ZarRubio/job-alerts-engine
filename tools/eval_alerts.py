#!/usr/bin/env python3
"""Evaluate the job-alert scorer against a labelled corpus.

The corpus (job_scraper/eval/corpus.jsonl) holds real postings collected with
`python tools/job_alerts.py --collect job_scraper/eval/corpus.jsonl`, each with a
human label: 1 = worth an alert for this candidate, 0 = not. The scorer is
treated as a binary classifier ("alert" = fit high or medium) and reported with
precision, recall and F1, plus the precision of the "high" bucket and the
misclassified postings so a tuning change can be judged by numbers.

    python tools/eval_alerts.py                 # report
    python tools/eval_alerts.py --errors        # also list false positives/negatives
    python tools/eval_alerts.py --json          # machine-readable
    python tools/eval_alerts.py --confident     # ignore postings labelled as unsure
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import job_alerts  # noqa: E402
from alerting.common import ROOT  # noqa: E402

CORPUS = ROOT / "job_scraper" / "eval" / "corpus.jsonl"


def load_corpus(path: Path) -> list[dict]:
    rows = []
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("label") not in (0, 1):
            raise ValueError(f"{path}:{n}: label must be 0 or 1, got {row.get('label')!r}")
        rows.append(row)
    return rows


def ratio(num: int, den: int) -> float | None:
    return round(num / den, 3) if den else None


def evaluate(rows: list[dict], config: dict, confident_only: bool = False) -> dict:
    scorer = job_alerts.Scorer(config["scoring"], config["portals"])
    tp: list[dict] = []
    fp: list[dict] = []
    fn: list[dict] = []
    tn: list[dict] = []
    high = high_ok = 0
    for row in rows:
        if confident_only and row.get("unsure"):
            continue
        out = scorer.score(row)
        alert = out["fit"] in ("high", "medium")
        item = {
            "title": row["title"],
            "company": row["company"],
            "location": row.get("location"),
            "score": out["score"],
            "fit": out["fit"],
            "label": row["label"],
            "why": out["reasons"] + [f"- {p}" for p in out["penalties"]],
        }
        if out["fit"] == "high":
            high += 1
            high_ok += row["label"]
        (tp if alert and row["label"] else fp if alert else fn if row["label"] else tn).append(item)
    precision = ratio(len(tp), len(tp) + len(fp))
    recall = ratio(len(tp), len(tp) + len(fn))
    f1 = round(2 * precision * recall / (precision + recall), 3) if precision and recall else 0.0
    return {
        "postings": len(tp) + len(fp) + len(fn) + len(tn),
        "positives": len(tp) + len(fn),
        "alerts": len(tp) + len(fp),
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "high_alerts": high,
        "high_precision": ratio(high_ok, high),
        "confusion": {"tp": len(tp), "fp": len(fp), "fn": len(fn), "tn": len(tn)},
        "false_positives": sorted(fp, key=lambda j: -j["score"]),
        "false_negatives": sorted(fn, key=lambda j: -j["score"]),
    }


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--config", type=Path, default=job_alerts.CONFIG)
    ap.add_argument("--confident", action="store_true", help="skip postings labelled unsure")
    ap.add_argument("--errors", action="store_true", help="list false positives and false negatives")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    result = evaluate(load_corpus(args.corpus), job_alerts.load_config(args.config), args.confident)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    c = result["confusion"]
    print(f"Postings: {result['postings']} ({result['positives']} relevant) | alerts sent: {result['alerts']}")
    print(f"Precision {pct(result['precision'])} | Recall {pct(result['recall'])} | F1 {result['f1']}")
    print(f"High bucket: {result['high_alerts']} alerts, precision {pct(result['high_precision'])}")
    print(f"Confusion: TP {c['tp']} FP {c['fp']} FN {c['fn']} TN {c['tn']}")
    if args.errors:
        for name in ("false_positives", "false_negatives"):
            print(f"\n{name.replace('_', ' ').title()}:")
            for j in result[name]:
                print(f"  [{j['fit']} {j['score']}] {j['title'][:70]} - {j['company']} | {'; '.join(j['why'])[:140]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
