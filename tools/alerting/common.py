"""Paths, constants and logging shared by the job-alert modules."""

from __future__ import annotations

import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


CONFIG = ROOT / "job_scraper" / "alert_config.json"


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
