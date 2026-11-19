"""Deterministic fit score: role (title), stack coverage (description), location and language gates."""

from __future__ import annotations

import re
from typing import Any


class Scorer:
    """Deterministic fit score from the config's `scoring` rules."""

    def __init__(self, rules: dict, portals: dict | None = None):
        c = lambda pats: [re.compile(p, re.IGNORECASE) for p in pats]  # noqa: E731
        # Per-portal `location_allow`: on a remote-only board, a posting whose
        # location names none of these (e.g. "Remote · USA") is excluded.
        self.location_allow = {
            name: c(settings["location_allow"])
            for name, settings in (portals or {}).items()
            if isinstance(settings, dict) and settings.get("location_allow")
        }
        self.base = rules.get("base", 25)
        self.high = rules.get("high_threshold", 65)
        self.medium = rules.get("medium_threshold", 45)
        self.cap = rules.get("non_tech_score_cap", 20)
        self.rules = [
            {**r, "rx": c(r.get("patterns", []))} for r in (rules.get("positive") or []) + (rules.get("negative") or [])
        ]
        ang = rules.get("angular_only") or {}
        self.angular = (
            {**ang, "rx": re.compile(ang["pattern"], re.I), "unless_rx": re.compile(ang.get("unless") or "$^", re.I)}
            if ang.get("pattern")
            else None
        )
        self.years = rules.get("years") or {}
        # Stack coverage: which of the technologies the posting asks for the
        # candidate already has (1), knows partially (0.5) or lacks (0).
        st = rules.get("stack") or {}
        self.stack_cfg = {k: v for k, v in st.items() if not isinstance(v, dict)}
        self.stack = [
            (name, tier, re.compile(pattern, re.I))
            for tier in ("have", "partial", "missing")
            for name, pattern in (st.get(tier) or {}).items()
        ]
        heads = rules.get("about_headings") or []
        self.about_rx = re.compile(rf"(?:{'|'.join(heads)})\s*:?\s*", re.I) if heads else None
        nt = rules.get("non_tech") or {}
        self.non_tech = c(nt.get("patterns", []))
        self.non_tech_unless = re.compile(nt.get("unless") or "$^", re.I)
        self.non_tech_reason = nt.get("reason", "rol no técnico")
        loc = rules.get("location") or {}
        self.other_city = c(loc.get("other_city_patterns", []))
        self.relocation = c(loc.get("relocation_patterns", []))
        self.presencial = c(loc.get("presencial_patterns", []))
        self.hybrid = c(loc.get("hybrid_remote_patterns", []))
        self.remote = c(loc.get("remote_patterns", [])) or self.hybrid
        self.home = c(loc.get("home_patterns", []))
        self.lima_districts = c(loc.get("lima_district_patterns", []))
        self.foreign = c(loc.get("foreign_patterns", []))
        self.foreign_title = c(loc.get("foreign_title_patterns", []))
        blocked = rules.get("blocked_companies") or {}
        self.blocked = c(blocked.get("patterns", []))
        self.blocked_reason = blocked.get("reason", "empresa bloqueada")
        self.bi_cfg = rules.get("bi_track") or {}
        self.bi_title = c(self.bi_cfg.get("title_patterns", []))
        self.bi_requires = c(self.bi_cfg.get("requires", []))
        # Modality priority: hybrid/remote postings rank above onsite ones.
        self.modality = loc.get("modality_points") or {}
        # "US only", "must reside in the US", "EST hours"...: a remote job tied
        # to another country or timezone is excluded on any portal.
        self.restricted = c(loc.get("restricted_patterns", []))
        lang = rules.get("language") or {}
        self.english = c(lang.get("advanced_english_patterns", []))
        markers = "|".join(lang.get("required_markers", [])) or "$^"
        self.languages = [
            (
                name,
                re.compile(
                    rf"(?:{name})[^.;,\n]{{0,25}}(?:{markers})"
                    rf"|(?:fluent in|fluency in|dominio (?:del? )?|native)\s*(?:{name})",
                    re.I,
                ),
            )
            for name in lang.get("other_languages", [])
        ]

    @staticmethod
    def _hit(rx, text: str):
        return next((m for p in rx if (m := p.search(text))), None)

    def required_years(self, text: str) -> int | None:
        n = r"(\d{1,2})(?:\s*(?:-|a|to|–)\s*\d{1,2})?\s*\+?\s*"
        unit = r"(?:a[nñ]os|years?|yrs?)"
        patterns = [
            rf"{n}{unit}\s*(?:de|of)?\s*(?:experiencia|experience|exp\b|en |in |trabajando|working)",
            rf"(?:experiencia|experience)[^.\n]{{0,40}}?{n}{unit}",
            rf"(?:m[ií]nimo|at least|al menos|minimum)\s*(?:de\s*)?{n}{unit}",
        ]
        found = [int(m.group(1)) for p in patterns for m in re.finditer(p, text, re.I)]
        found = [v for v in found if 0 < v <= 20]
        return max(found) if found else None

    def stack_coverage(self, text: str) -> dict:
        """Technologies the posting names, split by how well the candidate covers them."""
        found: dict[str, Any] = {"have": [], "partial": [], "missing": []}
        for name, tier, rx in self.stack:
            if rx.search(text):
                found[tier].append(name)
        total = len(found["have"]) + len(found["partial"]) + len(found["missing"])
        found["coverage"] = round((len(found["have"]) + 0.5 * len(found["partial"])) / total, 2) if total else None
        return found

    def about(self, desc: str, limit: int = 200) -> str:
        """One-line 'what is this job about': the text after a responsibilities heading, else the opening."""
        text = " ".join((desc or "").split())
        if not text:
            return ""
        m = self.about_rx.search(text) if self.about_rx else None
        snippet = text[m.end() :] if m and len(text) - m.end() > 40 else text
        if len(snippet) <= limit:
            return snippet
        cut = snippet[:limit].rsplit(" ", 1)[0]
        return cut.rstrip(",;:-–") + "…"

    def score(self, job: dict) -> dict:
        title = job.get("title") or ""
        desc = job.get("description") or ""
        location = job.get("location") or ""
        everything = f"{title}\n{location}\n{desc}"
        score = self.base
        reasons: list[str] = []
        penalties: list[str] = []
        flags: list[str] = []
        excluded = None

        # Rules sharing a `group` (role categories, seniority level) do not add up:
        # a title naming three categories is one role, so only the strongest
        # title hit and the strongest description-only hit of each group count.
        best: dict = {}
        for rule in self.rules:
            points, where = 0, None
            if self._hit(rule["rx"], title):
                points, where = rule.get("title", 0), "title"
            elif desc and self._hit(rule["rx"], desc):
                points, where = rule.get("description", 0), "description"
            if not points:
                continue
            group = rule.get("group")
            if group:
                slot = (group, where)
                if slot not in best or points > best[slot][0]:
                    best[slot] = (points, rule["reason"])
                continue
            score += points
            (reasons if points > 0 else penalties).append(rule["reason"])
        for points, reason in best.values():
            score += points
            (reasons if points > 0 else penalties).append(reason)

        if self.angular and self.angular["rx"].search(everything) and not self.angular["unless_rx"].search(everything):
            points = self.angular["title"] if self.angular["rx"].search(title) else self.angular["description"]
            score += points
            penalties.append(self.angular["reason"])

        years = self.required_years(f"{title}\n{desc}")
        threshold = self.years.get("threshold", 4)
        if years is not None and years >= threshold:
            pen = self.years.get("penalty", 15) + self.years.get("per_extra_year", 5) * (years - threshold)
            score -= min(pen, self.years.get("max_penalty", 35))
            penalties.append(f"pide {years}+ años de experiencia")

        stack = self.stack_coverage(f"{title}\n{desc}") if desc else None
        cfg = self.stack_cfg
        if stack and stack["coverage"] is not None:
            asked = len(stack["have"]) + len(stack["partial"]) + len(stack["missing"])
            if asked >= cfg.get("min_terms", 3):
                pts = (stack["coverage"] - cfg.get("pivot", 0.6)) * cfg.get("points", 40)
                pts = int(round(max(-cfg.get("max_penalty", 15), min(cfg.get("max_bonus", 12), pts))))
                score += pts
                label = f"stack {round(stack['coverage'] * 100)}% cubierto"
                if pts > 0:
                    reasons.append(label)
                elif pts < 0:
                    gaps = ", ".join(stack["missing"][:3]) or ", ".join(stack["partial"][:3])
                    penalties.append(f"{label} (falta: {gaps})")

        non_tech = bool(self._hit(self.non_tech, title)) and not self.non_tech_unless.search(title)
        if non_tech:
            score = min(score, self.cap)
            penalties.append(self.non_tech_reason)

        remote_ok = bool(self._hit(self.hybrid, everything))
        allow = self.location_allow.get(job.get("portal") or "")
        restricted = self._hit(self.restricted, everything)
        if self._hit(self.relocation, f"{title}\n{desc}"):
            excluded = "requiere reubicación"
        elif (
            (city := self._hit(self.other_city, f"{location}\n{title}"))
            and not self._hit(self.remote, everything)
            # "San Borja, Huánuco": a Lima district beats a mislabelled region.
            and not self._hit(self.lima_districts, location)
        ):
            excluded = f"fuera de Lima ({location if self._hit(self.other_city, location) else city.group(0)})"
        elif self.blocked and self._hit(self.blocked, job.get("company") or ""):
            excluded = self.blocked_reason
        elif self._hit(self.foreign_title, title) and not (
            self._hit(self.remote, everything) and self._hit(self.home, location)
        ):
            excluded = "aviso de otro país (título)"
        elif self._hit(self.foreign, location) and not self._hit(self.home, location):
            excluded = f"fuera del Perú ({location[:40]})"
        elif allow is not None and not self._hit(allow, location):
            excluded = f"remoto restringido ({location or 's/d'})"
        elif restricted:
            excluded = f"restringido a otro país/zona ({' '.join(restricted.group(0).split())[:40]})"
        presencial = bool(self._hit(self.presencial, everything)) and not remote_ok
        modality = "híbrido/remoto" if remote_ok else ("presencial" if presencial else None)
        if presencial:
            flags.append("⚠ presencial")
        if remote_ok and self.modality.get("hybrid_remote"):
            score += self.modality["hybrid_remote"]
            reasons.append(self.modality.get("hybrid_remote_reason", "híbrido/remoto"))
        elif presencial and self.modality.get("presencial"):
            score += self.modality["presencial"]
            penalties.append(self.modality.get("presencial_reason", "presencial"))
        if self._hit(self.english, everything):
            flags.append("⚠ inglés avanzado (tienes B2)")
        for name, rx in self.languages:
            if rx.search(everything):
                excluded = excluded or f"requiere otro idioma ({name})"
                break
        if not desc:
            flags.append("solo título (sin descripción)")

        # BI / data-analyst track: alert only when the posting also asks for
        # Python, automation or AI, and never above "medium" so it cannot
        # crowd out development and AI roles.
        if self.bi_title and self._hit(self.bi_title, title):
            if desc and self._hit(self.bi_requires, desc):
                score = min(score, self.high - 1)
                reasons.append(self.bi_cfg.get("reason_with", "BI con Python/IA (máx. medio)"))
            else:
                score = min(score, self.medium - 1)
                penalties.append(self.bi_cfg.get("reason_without", "BI sin Python/automatización/IA"))
        score = max(0, min(100, int(score)))
        if excluded or non_tech:
            fit = "low"
        elif score >= self.high:
            fit = "high"
        elif score >= self.medium:
            fit = "medium"
        else:
            fit = "low"
        if excluded:
            penalties.append(excluded)
        dedup = lambda items: list(dict.fromkeys(items))  # noqa: E731
        return {
            "score": score,
            "fit": fit,
            "excluded": bool(excluded),
            "non_tech": non_tech,
            "reasons": dedup(reasons)[:5],
            "penalties": dedup(penalties)[:4],
            "flags": dedup(flags),
            "about": self.about(desc),
            "years": years,
            "modality": modality,
            "stack": stack,
        }
