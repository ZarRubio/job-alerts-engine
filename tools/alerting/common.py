"""Paths, constants and logging shared by the job-alert modules."""

from __future__ import annotations

import os
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent


def _project_root() -> Path:
    """Where config, state and portals live.

    JOB_ALERTS_HOME wins; otherwise the repository checkout (also when installed
    with `pip install -e .`); otherwise the current directory, for a regular
    `pip install .` run from a project folder.
    """
    if os.environ.get("JOB_ALERTS_HOME"):
        return Path(os.environ["JOB_ALERTS_HOME"]).resolve()
    repo = TOOLS.parent
    if (repo / "job_scraper" / "alert_config.json").is_file():
        return repo
    return Path.cwd()


ROOT = _project_root()
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


CONFIG = ROOT / "job_scraper" / "alert_config.json"
SEEN_STATE = ROOT / "job_scraper" / "seen_jobs.json"
TRACKER = ROOT / "job_search_tracker.csv"


ALERTS_STATE = ROOT / "job_scraper" / "alerts_state.json"


SKILLS = ROOT / "portals"


FIT_RANK = {"high": 0, "medium": 1, "low": 2}


FIT_LABEL = {"high": "ALTA", "medium": "MEDIA", "low": "BAJA"}


FIT_ICON = {"high": "🟢", "medium": "🟡", "low": "⚪"}


CLI_TIMEOUT = 120


OR_MAX = 5  # freehire rejects a sixth OR alternative


COLLAPSE_RATIO = 0.9


CALLMEBOT_URL = "https://api.callmebot.com/whatsapp.php"


WHATSAPP_MAX_ENCODED = 1800  # keep the GET URL comfortably short


def log(message: str) -> None:
    print(f"job_alerts: {message}", file=sys.stderr)
