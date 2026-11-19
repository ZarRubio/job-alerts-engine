"""Notifications: email and WhatsApp bodies, channels and secret redaction."""

from __future__ import annotations

import smtplib
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from html import escape
from typing import Any

from alerting.common import (
    CALLMEBOT_URL,
    FIT_ICON,
    FIT_LABEL,
    WHATSAPP_MAX_ENCODED,
    log,
)
from alerting.search import portal_label


def short_url(job: dict) -> str:
    if job.get("portal") == "linkedin-search" and job.get("id", "").isdigit():
        return f"https://www.linkedin.com/jobs/view/{job['id']}"
    return job["url"]


def secrets(env) -> list[str]:
    names = ("ALERT_SMTP_USER", "ALERT_SMTP_APP_PASSWORD", "ALERT_EMAIL_TO", "CALLMEBOT_PHONE", "CALLMEBOT_APIKEY")
    values = [str(env.get(n) or "").strip() for n in names]
    values += ["".join(v.split()) for v in values]  # also redact the space-stripped app password
    return sorted({v for v in values if len(v) >= 3}, key=len, reverse=True)


def redact(text: str, env) -> str:
    text = str(text)
    for value in secrets(env):
        text = text.replace(value, "***")
        text = text.replace(urllib.parse.quote(value), "***")
    return text


def subject_line(alerts: list[dict], now: datetime) -> str:
    n = len(alerts)
    highs = sum(1 for a in alerts if a["fit"] == "high")
    noun = "oferta nueva" if n == 1 else "ofertas nuevas"
    return f"🔔 {n} {noun} para ti ({highs} alta{'s' if highs != 1 else ''}) — {now.strftime('%d/%m %H:%M')}"


def _line_notes(job: dict) -> str:
    notes = list(job["reasons"]) + [f"− {p}" for p in job["penalties"]]
    if job.get("count", 1) > 1:
        notes.append(f"{job['count']} avisos similares")
    return "; ".join(notes)


def stack_line(job: dict) -> str:
    """'✓ Python, React · ~ Azure · ✗ Kubernetes' plus years and modality, or ''."""
    stack = job.get("stack") or {}
    parts = [
        f"{mark} {', '.join(stack[tier][:6])}"
        for mark, tier in (("✓", "have"), ("~", "partial"), ("✗", "missing"))
        if stack.get(tier)
    ]
    if job.get("years"):
        parts.append(f"pide {job['years']}+ años")
    if job.get("modality"):
        parts.append(job["modality"])
    return " · ".join(parts)


def email_bodies(alerts: list[dict], now: datetime, home: str = "Lima") -> tuple[str, str]:
    lines = [
        f"Ofertas nuevas que encajan contigo ({now.strftime('%d/%m/%Y %H:%M')}, hora de {home}):",
        "Stack: ✓ lo dominas · ~ lo conoces o estás aprendiendo · ✗ no lo tienes",
        "",
    ]
    rows = []
    for job in alerts:
        lines += [
            f"[{FIT_LABEL[job['fit']]} {job['score']}] {job['title']} — {job['company']} ({job['location'] or 's/d'})",
            f"  {short_url(job)}  (vía {job.get('source') or portal_label(job['portal'])})",
        ]
        if job.get("about"):
            lines.append(f"  De qué trata: {job['about']}")
        if stack_line(job):
            lines.append(f"  Pide: {stack_line(job)}")
        if job["flags"]:
            lines.append(f"  Avisos: {', '.join(job['flags'])}")
        lines += [f"  Motivos: {_line_notes(job)}", ""]
        about_html = (
            (f"<div>{escape(job['about'])}</div>" if job.get("about") else "")
            + (f"<div style='color:#555'>{escape(stack_line(job))}</div>" if stack_line(job) else "")
        ) or "—"
        rows.append(
            "<tr>"
            f"<td>{FIT_ICON[job['fit']]} {FIT_LABEL[job['fit']]}</td>"
            f"<td style='text-align:right'>{job['score']}</td>"
            f"<td><a href='{escape(short_url(job), quote=True)}'>{escape(job['title'])}</a></td>"
            f"<td>{escape(job['company'])}</td>"
            f"<td style='max-width:360px'>{about_html}</td>"
            f"<td>{escape(job.get('source') or portal_label(job['portal']))}</td>"
            f"<td>{escape(job['location'] or 's/d')}</td>"
            f"<td>{escape(', '.join(job['flags']))}</td>"
            f"<td>{escape(_line_notes(job))}</td>"
            "</tr>"
        )
    lines.append("Generado automáticamente por tools/job_alerts.py.")
    html = (
        "<html><body style='font-family:Arial,sans-serif'>"
        f"<p>Ofertas nuevas que encajan contigo ({now.strftime('%d/%m/%Y %H:%M')}, hora de {home}):</p>"
        "<p style='color:#666;font-size:12px'>"
        "Stack: ✓ lo dominas · ~ lo conoces o estás aprendiendo · ✗ no lo tienes</p>"
        "<table border='1' cellpadding='6' cellspacing='0' style='border-collapse:collapse;font-size:13px'>"
        "<tr><th>Encaje</th><th>Puntaje</th><th>Puesto</th><th>Empresa</th><th>De qué trata</th>"
        "<th>Fuente</th><th>Ubicación</th>"
        "<th>Avisos</th><th>Motivos</th></tr>"
        + "".join(rows)
        + "</table><p style='color:#666;font-size:12px'>Generado automáticamente por tools/job_alerts.py.</p>"
        "</body></html>"
    )
    return "\n".join(lines), html


def whatsapp_messages(
    alerts: list[dict], top: int, now: datetime, max_encoded: int = WHATSAPP_MAX_ENCODED
) -> list[str]:
    shown = alerts[: max(1, top)]
    header = subject_line(alerts, now)
    items = []
    for job in shown:
        extra = f" (x{job['count']})" if job.get("count", 1) > 1 else ""
        warn = " ⚠" if any(f.startswith("⚠") for f in job["flags"]) else ""
        source = job.get("source") or portal_label(job["portal"])
        items.append(
            f"{FIT_ICON[job['fit']]} {FIT_LABEL[job['fit']]} {job['score']}{warn} · "
            f"{job['title']} — {job['company']}{extra} (vía {source})\n{short_url(job)}"
        )
    if len(alerts) > len(shown):
        items.append(f"…y {len(alerts) - len(shown)} más en tu correo.")
    messages, current = [], header
    for item in items:
        candidate = f"{current}\n\n{item}"
        if len(urllib.parse.quote(candidate)) > max_encoded and current:
            messages.append(current)
            current = item
        else:
            current = candidate
    messages.append(current)
    return messages


def email_channel(env) -> dict | None:
    user, password, to = (
        str(env.get(n) or "").strip() for n in ("ALERT_SMTP_USER", "ALERT_SMTP_APP_PASSWORD", "ALERT_EMAIL_TO")
    )
    password = "".join(password.split())  # Google shows app passwords as "xxxx xxxx xxxx xxxx"
    if not (user and password and to):
        return None
    return {
        "user": user,
        "password": password,
        "to": [t.strip() for t in to.split(",") if t.strip()],
        "host": str(env.get("ALERT_SMTP_HOST") or "smtp.gmail.com"),
        "port": int(env.get("ALERT_SMTP_PORT") or 465),
    }


def whatsapp_channel(env) -> dict | None:
    phone, apikey = (str(env.get(n) or "").strip() for n in ("CALLMEBOT_PHONE", "CALLMEBOT_APIKEY"))
    return {"phone": phone, "apikey": apikey} if phone and apikey else None


def send_email(channel: dict, subject: str, text: str, html: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = channel["user"]
    msg["To"] = ", ".join(channel["to"])
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    with smtplib.SMTP_SSL(channel["host"], channel["port"], context=ssl.create_default_context(), timeout=30) as smtp:
        smtp.login(channel["user"], channel["password"])
        smtp.send_message(msg)


def send_whatsapp(channel: dict, messages: list[str], delay: float) -> None:
    for index, text in enumerate(messages):
        if index:
            time.sleep(delay)
        query = urllib.parse.urlencode({"phone": channel["phone"], "text": text, "apikey": channel["apikey"]})
        with urllib.request.urlopen(f"{CALLMEBOT_URL}?{query}", timeout=30) as resp:
            if resp.status != 200:
                raise RuntimeError(f"CallMeBot HTTP {resp.status}")


# Extension point: a messaging provider is one entry here. `configure(env)`
# returns its settings (or None when its environment variables are absent, so
# the channel is skipped with a warning) and `send(settings, payload)` delivers
# or raises. Email is the primary channel; CallMeBot WhatsApp is optional and
# inert without its variables. A new provider (e.g. Telegram, Twilio) only
# needs its own configure/send pair and a line in CHANNELS.
CHANNELS: tuple[dict[str, Any], ...] = (
    {
        "name": "email",
        "configure": email_channel,
        "send": lambda cfg, p: send_email(cfg, p["subject"], p["text"], p["html"]),
        "missing": "set ALERT_SMTP_USER, ALERT_SMTP_APP_PASSWORD and ALERT_EMAIL_TO",
    },
    {
        "name": "whatsapp",
        "configure": whatsapp_channel,
        "send": lambda cfg, p: send_whatsapp(cfg, p["short"], p["delay"]),
        "missing": "set CALLMEBOT_PHONE and CALLMEBOT_APIKEY",
    },
)


def configured_channels(env) -> list[str]:
    return [c["name"] for c in CHANNELS if c["configure"](env) is not None]


def notify(env, payload: dict, errors: list) -> dict:
    """Send `payload` (subject, text, html, short, delay) on every configured channel.

    An exception's text is redacted of every secret value before it is kept,
    and only its type and message are recorded - never a request URL.
    """
    results = {}
    for channel in CHANNELS:
        settings = channel["configure"](env)
        if settings is None:
            results[channel["name"]] = "skipped"
            log(f"{channel['name']} skipped: {channel['missing']}")
            continue
        try:
            channel["send"](settings, payload)
            count = len(payload["short"]) if channel["name"] != "email" else 1
            results[channel["name"]] = "sent" if count == 1 else f"sent ({count})"
        except Exception as exc:  # noqa: BLE001 - one channel failing must not stop the others
            results[channel["name"]] = "failed"
            reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            message = f"{channel['name']}: {redact(f'{type(exc).__name__}: {reason}', env)}"
            errors.append(message)
            log(message)
    return results
