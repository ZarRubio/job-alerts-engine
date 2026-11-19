"""tools/eval_alerts.py: the alert scorer must keep its measured quality.

Runs the shipped scorer over the labelled corpus of real postings
(job_scraper/eval/corpus.jsonl). The floors sit a little under the measured
values (2026-11-19, after the user reviewed the unsure labels: precision
0.853, recall 0.939, F1 0.894, high-bucket precision 1.0), so a tuning change that degrades the classifier fails CI.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import eval_alerts  # noqa: E402
import job_alerts  # noqa: E402


@unittest.skipUnless(eval_alerts.CORPUS.is_file(), "labelled corpus not present (upstream template)")
class ScorerQualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = eval_alerts.evaluate(
            eval_alerts.load_corpus(eval_alerts.CORPUS), job_alerts.load_config(job_alerts.CONFIG)
        )

    def test_corpus_is_large_enough_to_mean_something(self):
        self.assertGreaterEqual(self.result["postings"], 200)
        self.assertGreaterEqual(self.result["positives"], 60)

    def test_alert_precision_recall_and_f1_floors(self):
        self.assertGreaterEqual(self.result["precision"], 0.83, self.result["confusion"])
        self.assertGreaterEqual(self.result["recall"], 0.91, self.result["confusion"])
        self.assertGreaterEqual(self.result["f1"], 0.87, self.result["confusion"])

    def test_high_bucket_is_trustworthy(self):
        self.assertGreaterEqual(self.result["high_precision"], 0.97)


class LoaderTests(unittest.TestCase):
    def test_unlabelled_rows_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.jsonl"
            path.write_text(json.dumps({"title": "x", "label": None}) + "\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                eval_alerts.load_corpus(path)

    def test_write_corpus_appends_only_new_keys_and_keeps_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.jsonl"
            path.write_text(json.dumps({"key": "a", "label": 1}) + "\n", encoding="utf-8")
            jobs = [{"key": "a", "title": "dup"}, {"key": "b", "title": "new"}]
            self.assertEqual(job_alerts.write_corpus(path, jobs), 1)
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([r["key"] for r in rows], ["a", "b"])
            self.assertEqual(rows[0]["label"], 1)
            self.assertIsNone(rows[1]["label"])


class SampleCorpusTests(unittest.TestCase):
    """The shipped synthetic sample exercises the evaluator end to end."""

    SAMPLE = Path(__file__).resolve().parent.parent / "examples" / "sample_corpus.jsonl"

    def test_sample_is_scored_and_reported(self):
        result = eval_alerts.evaluate(eval_alerts.load_corpus(self.SAMPLE), job_alerts.load_config(job_alerts.CONFIG))
        self.assertEqual(result["postings"], 12)
        self.assertEqual(result["positives"], 6)
        self.assertGreaterEqual(result["f1"], 0.8)

    def test_cli_prints_metrics_errors_and_json(self):
        import contextlib
        import io

        for argv, needle in (([], "Precision"), (["--errors"], "False Positives"), (["--json"], '"f1"')):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(eval_alerts.main(["--corpus", str(self.SAMPLE), *argv]), 0)
            self.assertIn(needle, out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(eval_alerts.main(["--corpus", str(self.SAMPLE), "--confident"]), 0)


if __name__ == "__main__":
    unittest.main()
