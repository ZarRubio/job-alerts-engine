"""tools/job_alerts.py: deterministic scoring, dedup, collapse and safe notifications.

Network-free: portal CLIs, SMTP and HTTP are mocked. The scoring cases run
against the shipped job_scraper/alert_config.json so a tuning edit that breaks
the intent (an AI junior role must alert, a call-center role must not) fails.
"""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import job_alerts  # noqa: E402

CONFIG = ROOT / "job_scraper" / "alert_config.json"
SECRETS = {
    "ALERT_SMTP_USER": "sender.secret@example.test",
    "ALERT_SMTP_APP_PASSWORD": "abcd efgh ijkl mnop",
    "ALERT_EMAIL_TO": "receiver.secret@example.test",
    "CALLMEBOT_PHONE": "+10000000000",
    "CALLMEBOT_APIKEY": "987654",
}


def job(title, company="Acme", description=None, location="Lima, Peru", url=None, portal="freehire-search", **extra):
    return {
        "portal": portal,
        "id": extra.pop("id", ""),
        "title": title,
        "company": company,
        "location": location,
        "date": extra.pop("date", "2026-11-10"),
        "url": url or f"https://jobs.test/{abs(hash((title, company)))}",
        "description": description,
        "categories": ["ai_engineering"],
        "count": 1,
        **extra,
    }


class ScorerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scorer = job_alerts.Scorer(job_alerts.load_config(CONFIG)["scoring"])

    def score(self, *args, **kwargs):
        return self.scorer.score(job(*args, **kwargs))

    def test_junior_ai_role_is_high(self):
        out = self.score(
            "Desarrollador IA Junior",
            description="Construirás agentes de IA con LLM, RAG y Python (FastAPI). Modalidad híbrida en Lima.",
        )
        self.assertEqual(out["fit"], "high", out)
        self.assertIn("IA/LLM (tu meta de carrera)", out["reasons"])

    def test_senior_role_with_five_years_is_penalised(self):
        plain = self.score("Full Stack Developer", description="React y Node.js. Remoto.")
        senior = self.score(
            "Senior Full Stack Developer", description="React y Node.js. Mínimo 5+ años de experiencia. Remoto."
        )
        self.assertLess(senior["score"], plain["score"] - 30)
        self.assertNotEqual(senior["fit"], "high")
        self.assertIn("pide 5+ años de experiencia", senior["penalties"])

    def test_years_parser_reads_ranges_and_ignores_company_age(self):
        self.assertEqual(self.scorer.required_years("Requisitos: 3 a 5 años de experiencia"), 3)
        self.assertEqual(self.scorer.required_years("At least 6 years of experience"), 6)
        self.assertIsNone(self.scorer.required_years("Leading the way for over 15 years. We deliver."))

    def test_call_center_role_is_low(self):
        out = self.score("Asesor de Call Center", description="Atención telefónica con IA y CRM.")
        self.assertEqual(out["fit"], "low")
        self.assertTrue(out["non_tech"])
        self.assertLessEqual(out["score"], 20)

    def test_advanced_english_is_flagged_not_excluded(self):
        out = self.score("AI Engineer", description="Python, LLM. Inglés avanzado. Remoto.")
        self.assertIn("⚠ inglés avanzado (tienes B2)", out["flags"])
        self.assertFalse(out["excluded"])
        self.assertIn(out["fit"], ("high", "medium"))

    def test_other_required_language_is_excluded(self):
        out = self.score("AI Engineer", description="Python, LLM. Portugués fluido indispensable.")
        self.assertTrue(out["excluded"])
        self.assertEqual(out["fit"], "low")
        nice = self.score("AI Engineer", description="Python, LLM. Inglés avanzado; portugués deseable.")
        self.assertFalse(nice["excluded"], nice)

    def test_presencial_is_flagged_and_hybrid_is_not(self):
        self.assertIn(
            "⚠ presencial",
            self.score("Desarrollador Full Stack", description="Trabajo presencial en San Isidro.")["flags"],
        )
        self.assertNotIn(
            "⚠ presencial", self.score("Desarrollador Full Stack", description="Híbrido: 2 días presencial.")["flags"]
        )

    def test_hybrid_and_remote_rank_above_onsite(self):
        onsite = self.score("Desarrollador Full Stack", description="React y Node. Trabajo presencial en San Isidro.")
        hybrid = self.score("Desarrollador Full Stack", description="React y Node. Modalidad híbrida en San Isidro.")
        remote = self.score("Desarrollador Full Stack", description="React y Node. 100% remoto.")
        self.assertGreater(hybrid["score"], onsite["score"])
        self.assertGreater(remote["score"], onsite["score"])
        self.assertIn("100% presencial", onsite["penalties"])

    def test_semi_senior_is_not_penalized_as_senior(self):
        self.assertNotIn("seniority alta en el título", self.score("Desarrollador Full Stack Semi Senior")["penalties"])
        self.assertNotIn("seniority alta en el título", self.score("Semi-Senior Python Developer")["penalties"])
        self.assertIn("seniority alta en el título", self.score("Desarrollador Senior")["penalties"])

    def test_legacy_microsoft_stack_is_penalized(self):
        legacy = self.score(
            "Full Stack Developer", description="Migrate Classic ASP and VBScript to ASP.NET Core; IIS."
        )
        modern = self.score("Full Stack Developer", description="React and Node.js APIs.")
        self.assertLess(legacy["score"], modern["score"])

    def test_relocation_and_other_city_are_excluded(self):
        self.assertTrue(self.score("Desarrollador Python", description="Requiere reubicación a Santiago.")["excluded"])
        self.assertTrue(
            self.score("Desarrollador Python", location="Arequipa, Peru", description="Oficina central.")["excluded"]
        )
        self.assertFalse(
            self.score("Desarrollador Python", location="Arequipa, Peru", description="100% remoto.")["excluded"]
        )

    def test_province_jobs_need_full_remote_not_hybrid(self):
        self.assertTrue(
            self.score("Desarrollador Java - Provincia", location="Peru", description="Modalidad híbrida.")["excluded"]
        )
        self.assertTrue(
            self.score("Analista Programador", location="Huánuco, Peru", description="Híbrido.")["excluded"]
        )
        # A Lima district wins over a mislabelled region.
        self.assertFalse(
            self.score("Analista Programador", location="San Borja, Huánuco", description="Híbrido.")["excluded"]
        )
        self.assertFalse(
            self.score(
                "Full Stack Engineer - Remote Work", location="Cajamarca, Cajamarca", description="Python. Remote."
            )["excluded"]
        )

    def test_foreign_locations_are_excluded(self):
        linz = self.score(
            "Software Backend Developer with a Passion for AI (m/f/d) - Location: Linz",
            location="Peru",
            description="Python, FastAPI.",
        )
        self.assertTrue(linz["excluded"], linz)
        apac = self.score("Python Specialist", location="India; Australia; Japan; Singapore", description="Remote.")
        self.assertTrue(apac["excluded"], apac)
        self.assertTrue(
            self.score("Backend Developer (Python)", location="Medellín, Colombia", description="Híbrido.")["excluded"]
        )
        for loc in (
            "Hybrid · Lima, Peru; Santiago, Chile",
            "Colombia, Peru",
            "Remote · Worldwide",
            "Remote · LATAM, Europe",
        ):
            with self.subTest(loc=loc):
                self.assertFalse(
                    self.score("Full Stack Developer", location=loc, description="React. Remoto.")["excluded"]
                )

    def test_claude_code_mention_is_a_bonus(self):
        base = self.score("Desarrollador Full Stack", description="React, Node.js.")
        bonus = self.score("Desarrollador Full Stack", description="React, Node.js. Usamos Claude Code a diario.")
        self.assertGreaterEqual(bonus["score"] - base["score"], 20)
        self.assertIn("menciona Claude Code", bonus["reasons"])

    def test_customer_support_agent_is_not_an_ai_role(self):
        out = self.score("Customer Support Agent", description="Help students. Python and React knowledge is a plus.")
        self.assertEqual(out["fit"], "low", out)

    def test_ai_training_gigs_are_not_ai_engineering_roles(self):
        for title in ("AI Trainer (ML Engineering)", "ML Engineer (MSc. or PhD)", "STEM Expert – Chemistry (PhD)"):
            with self.subTest(title=title):
                out = self.score(
                    title, location="Remote · Worldwide", description="Train LLMs with Python. Remote contract."
                )
                self.assertEqual(out["fit"], "low", out)
        real = self.score("AI Engineer", location="Remote · Peru", description="Python, LLM, RAG. Remote.")
        self.assertIn(real["fit"], ("high", "medium"))

    def test_stack_coverage_rewards_your_stack_and_penalises_foreign_ones(self):
        mine = self.score("Software Engineer", description="Python, FastAPI, React, PostgreSQL y Docker. Remoto.")
        foreign = self.score("Software Engineer", description="Go, Kubernetes, Kafka, Terraform y Python. Remoto.")
        self.assertEqual(mine["stack"]["coverage"], 1.0)
        self.assertEqual(foreign["stack"]["missing"], ["Go", "Kubernetes", "Terraform", "Kafka"])
        self.assertGreaterEqual(mine["score"] - foreign["score"], 25)
        self.assertTrue(any(p.startswith("stack 20% cubierto (falta: Go") for p in foreign["penalties"]), foreign)

    def test_stack_is_not_scored_twice_for_the_same_keyword(self):
        # Two terms are below min_terms: no coverage points, and no per-technology description points either.
        bare = self.score("Software Engineer", description="Equipo en Lima.")
        two = self.score("Software Engineer", description="Python y SQL. Equipo en Lima.")
        self.assertEqual(two["score"], bare["score"])

    def test_role_categories_in_one_title_do_not_add_up(self):
        one = self.score("Desarrollador IA", description="Equipo en Lima.")
        many = self.score("Desarrollador Full Stack IA de Automatización Odoo", description="Equipo en Lima.")
        self.assertEqual(many["score"], one["score"])

    def test_non_development_roles_are_not_high(self):
        for title in (
            "Product Owner, AI Pod",
            "Legal Engineer - AI and Legal Automation",
            "Analista Junior de Tesorería",
            "Automation QA Teaching Experts (Python)",
        ):
            with self.subTest(title=title):
                out = self.score(title, description="IA, automatización, Python, SQL y Power Automate. Remoto.")
                self.assertNotEqual(out["fit"], "high", out)

    def test_bi_roles_alert_only_with_python_automation_or_ai_and_never_high(self):
        plain = self.score("Analista BI", description="Power BI, SQL y Excel. Modalidad híbrida.")
        self.assertEqual(plain["fit"], "low", plain)
        self.assertIn("BI sin Python/automatización/IA", plain["penalties"])
        smart = self.score("Analista BI", description="Power BI, SQL, Python y automatización con IA. Remoto.")
        self.assertEqual(smart["fit"], "medium", smart)

    def test_about_uses_the_responsibilities_section(self):
        desc = (
            "Somos una fintech líder en la región con 500 colaboradores. "
            "Responsabilidades: diseñar agentes de IA para automatizar la cobranza y medir su impacto. "
            "Requisitos: Python."
        )
        out = self.score("AI Engineer", description=desc)
        self.assertTrue(out["about"].startswith("diseñar agentes de IA"), out["about"])
        long = self.score("AI Engineer", description="palabra " * 100)
        self.assertLessEqual(len(long["about"]), 201)
        self.assertTrue(long["about"].endswith("…"))

    def test_title_only_posting_is_flagged(self):
        self.assertIn("solo título (sin descripción)", self.score("AI Engineer")["flags"])


class RemotePortalScoringTests(unittest.TestCase):
    """Remote-only boards: postings tied to another country or timezone must not alert."""

    @classmethod
    def setUpClass(cls):
        config = job_alerts.load_config(CONFIG)
        cls.scorer = job_alerts.Scorer(config["scoring"], config["portals"])

    def score(self, *args, **kwargs):
        return self.scorer.score(job(*args, **kwargs))

    def test_remotive_location_outside_latam_is_excluded(self):
        us = self.score(
            "Full Stack Developer",
            portal="remotive-search",
            location="Remote · USA",
            description="React, Node.js y TypeScript.",
        )
        self.assertTrue(us["excluded"], us)
        self.assertEqual(us["fit"], "low")
        latam = self.score(
            "Full Stack Developer",
            portal="remotive-search",
            location="Remote · LATAM, Europe",
            description="React, Node.js y TypeScript.",
        )
        self.assertFalse(latam["excluded"], latam)
        self.assertIn(latam["fit"], ("high", "medium"))

    def test_location_allow_applies_only_to_its_portal(self):
        out = self.score(
            "Full Stack Developer",
            portal="getonbrd-search",
            location="Hybrid · Lima, Peru",
            description="React y Node.js.",
        )
        self.assertFalse(out["excluded"], out)

    def test_country_restriction_in_the_description_is_excluded(self):
        for text in (
            "This role is US only.",
            "Candidates must be based in the United States.",
            "Requires US citizenship and an active security clearance.",
        ):
            with self.subTest(text=text):
                out = self.score(
                    "Full Stack Developer",
                    portal="himalayas-search",
                    location="Remote · Peru, Mexico",
                    description=f"React y Node.js. {text}",
                )
                self.assertTrue(out["excluded"], out)

    def test_us_clients_or_timezone_overlap_is_not_a_restriction(self):
        out = self.score(
            "Full Stack Developer",
            portal="himalayas-search",
            location="Remote · Peru",
            description="React y Node.js. You will work with US clients, overlap with EST hours.",
        )
        self.assertFalse(out["excluded"], out)


class BuildCallsTests(unittest.TestCase):
    def config(self, **portal):
        return {
            "queries": {"full_stack": ["react", "next.js"], "ai_engineering": ["AI engineer"]},
            "portals": {"p-search": {"enabled": True, "search_args": {"--jobage": "3"}, **portal}},
        }

    def test_default_uses_every_global_query(self):
        calls = job_alerts.build_calls(self.config())
        self.assertEqual([c["query"] for c in calls], ["react", "next.js", "AI engineer"])
        self.assertEqual(calls[0]["argv"], ["search", "--query", "react", "--jobage", "3", "--format", "json"])

    def test_single_call_portal_runs_once_without_query(self):
        calls = job_alerts.build_calls(self.config(single_call=True))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["argv"], ["search", "--jobage", "3", "--format", "json"])
        self.assertNotIn("--query", calls[0]["argv"])

    def test_portal_queries_and_categories_override_the_global_list(self):
        own = job_alerts.build_calls(self.config(queries=["full stack", "python"]))
        self.assertEqual([(c["category"], c["query"]) for c in own], [("portal", "full stack"), ("portal", "python")])
        subset = job_alerts.build_calls(self.config(query_categories=["ai_engineering"]))
        self.assertEqual([c["query"] for c in subset], ["AI engineer"])

    def test_boolean_search_arg_is_a_bare_flag(self):
        calls = job_alerts.build_calls(self.config(single_call=True, search_args={"--remote": True}))
        self.assertEqual(calls[0]["argv"], ["search", "--remote", "--format", "json"])

    def test_shipped_config_keeps_remotive_to_one_call_per_run(self):
        calls = job_alerts.build_calls(job_alerts.load_config(CONFIG))
        self.assertEqual(
            sum(1 for c in calls if c["portal"] == "remotive-search"),
            1,
            "Remotive's terms advise at most 4 requests a day; two runs a day must stay at one call each",
        )

    def test_hit_carries_its_source_for_attribution(self):
        raw = {"title": "Dev", "company": "Acme", "url": "https://remotive.com/remote-jobs/x-1", "source": "Remotive"}
        self.assertEqual(job_alerts.normalise_hit(raw, "remotive-search", "general")["source"], "Remotive")
        raw.pop("source")
        self.assertEqual(
            job_alerts.normalise_hit(
                raw, "getonbrd-search", "general", {"portals": {"getonbrd-search": {"label": "Get on Board"}}}
            )["source"],
            "Get on Board",
        )


class DedupTests(unittest.TestCase):
    def test_known_postings_are_skipped_and_mass_postings_collapse(self):
        hits = [
            job(
                "Python React Developer - Remote | REF#1001", "BairesDev", url="https://jobs.test/1", date="2026-11-09"
            ),
            job(
                "Python React Developer - Remote | REF#1002", "BairesDev", url="https://jobs.test/2", date="2026-11-10"
            ),
            job(
                "Python React Developer - Remote | REF#1003", "BairesDev", url="https://jobs.test/3", date="2026-11-08"
            ),
            job("Java Developer", "BairesDev", url="https://jobs.test/4"),
            job("AI Engineer", "Alerted", url="https://jobs.test/5"),
            job("Data Analyst", "Seen", url="https://jobs.test/6"),
            job("Odoo Developer", "Tracked", url="https://jobs.test/7"),
        ]
        alerts = {"x": {"url": "https://jobs.test/5/", "first_alerted": "2026-11-10"}}
        seen = {"seen_data-analyst": {"title": "Data Analyst", "company": "Seen", "url": "https://jobs.test/6"}}
        tracker = {("tracked", "odoodeveloper")}
        fresh, skipped = job_alerts.filter_known(hits, alerts, seen, tracker)
        self.assertEqual([j["title"] for j in fresh], ["Python React Developer - Remote | REF#1002", "Java Developer"])
        self.assertEqual(fresh[0]["count"], 3)
        self.assertEqual(len(fresh[0]["member_keys"]), 3)
        self.assertEqual(skipped, {"already_alerted": 1, "already_seen": 1, "already_applied": 1, "collapsed": 2})

    def test_prune_drops_entries_older_than_the_window(self):
        from datetime import date

        doc = {"alerts": {"old": {"first_alerted": "2026-09-01"}, "new": {"first_alerted": "2026-11-01"}, "odd": {}}}
        self.assertEqual(job_alerts.prune_alerts(doc, date(2026, 11, 11), 60), 1)
        self.assertEqual(set(doc["alerts"]), {"new", "odd"})


class RunTests(unittest.TestCase):
    """End-to-end run() with the CLIs, SMTP and HTTP mocked."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.state = self.tmp / "alerts_state.json"
        config = json.loads(CONFIG.read_text(encoding="utf-8"))
        config["queries"] = {"ai_engineering": ["AI engineer"]}
        # The run tests drive two mocked portals: one with detail calls, one that fails.
        config["portals"] = {
            "linkedin-search": {
                "enabled": True,
                "search_args": {"--limit": "20"},
                "combine_with_or": False,
                "delay_seconds": 0,
                "detail": True,
            },
            "freehire-search": {
                "enabled": True,
                "search_args": {"--limit": "20"},
                "combine_with_or": True,
                "delay_seconds": 0,
                "detail": False,
            },
        }
        self.config = self.tmp / "alert_config.json"
        self.config.write_text(json.dumps(config), encoding="utf-8")
        self.calls = []
        patches = [
            mock.patch.object(job_alerts.search, "run_cli", side_effect=self.fake_cli),
            mock.patch.object(job_alerts, "find_bun", return_value="bun"),
            mock.patch.object(job_alerts.time, "sleep"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fake_cli(self, bun, portal, argv):
        self.calls.append((portal, argv[0]))
        if argv[0] == "detail":
            if argv[1] == "222":
                return {"isActive": False, "description": "closed"}
            return {
                "isActive": True,
                "description": "Agentes de IA con LLM y Python. Remoto.",
                "location": "Lima, Peru",
            }
        if portal == "linkedin-search":
            return {
                "results": [
                    {
                        "id": "111",
                        "title": "Desarrollador IA Junior",
                        "company": "Acme",
                        "location": "Lima, Peru",
                        "date": "2026-11-10",
                        "url": "https://pe.linkedin.com/jobs/view/desarrollador-ia-111",
                    },
                    {
                        "id": "222",
                        "title": "AI Engineer",
                        "company": "Closed Co",
                        "location": "Lima, Peru",
                        "date": "2026-11-10",
                        "url": "https://pe.linkedin.com/jobs/view/ai-engineer-222",
                    },
                    {
                        "id": "333",
                        "title": "Asesor de Call Center",
                        "company": "Phones",
                        "location": "Lima, Peru",
                        "date": "2026-11-10",
                        "url": "https://pe.linkedin.com/jobs/view/asesor-333",
                    },
                ]
            }
        raise RuntimeError("freehire-search search exited 1: upstream down")

    def run_main(self, *argv, env=None):
        out, err = io.StringIO(), io.StringIO()
        args = [
            "--config",
            str(self.config),
            "--state",
            str(self.state),
            "--seen",
            str(self.tmp / "none.json"),
            "--tracker",
            str(self.tmp / "none.csv"),
            *argv,
        ]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = job_alerts.main(args, env=dict(env or {}))
        return code, json.loads(out.getvalue()), out.getvalue() + err.getvalue()

    def test_dry_run_scores_but_never_notifies_or_writes(self):
        with mock.patch.object(job_alerts.smtplib, "SMTP_SSL") as smtp:
            code, summary, _ = self.run_main("--dry-run", env=SECRETS)
        self.assertEqual(code, 0)
        smtp.assert_not_called()
        self.assertFalse(self.state.exists())
        self.assertEqual([h["title"] for h in summary["hits"]], ["Desarrollador IA Junior"])
        self.assertEqual(summary["skipped"]["inactive"], 1, "a closed LinkedIn posting must not alert")
        self.assertEqual(summary["searched"]["failed"], 1, "a failing portal is logged, not fatal")
        self.assertEqual(sum(1 for c in self.calls if c[1] == "detail"), 2, "non-tech titles are not detailed")

    def test_live_run_sends_email_records_state_and_never_leaks_secrets(self):
        env = {k: v for k, v in SECRETS.items() if k.startswith("ALERT_")}
        with mock.patch.object(job_alerts.smtplib, "SMTP_SSL") as smtp:
            code, summary, printed = self.run_main(env=env)
        self.assertEqual(code, 0)
        self.assertEqual(summary["channels"], {"email": "sent", "whatsapp": "skipped"})
        server = smtp.return_value.__enter__.return_value
        server.login.assert_called_once_with(
            SECRETS["ALERT_SMTP_USER"], "".join(SECRETS["ALERT_SMTP_APP_PASSWORD"].split())
        )
        msg = server.send_message.call_args[0][0]
        self.assertIn("1 oferta nueva para ti (1 alta)", msg["Subject"])
        self.assertIn("Desarrollador IA Junior", msg.get_body(("html",)).get_content())
        state = json.loads(self.state.read_text(encoding="utf-8"))["alerts"]
        self.assertEqual(list(state), summary["alerted"])
        for value in SECRETS.values():
            self.assertNotIn(value, printed)
        self.assertIn("whatsapp skipped", printed)

        # Second run: everything is already alerted, nothing is sent again.
        with mock.patch.object(job_alerts.smtplib, "SMTP_SSL") as smtp:
            code, summary, _ = self.run_main(env=env)
        smtp.assert_not_called()
        self.assertEqual(summary["hits"], [])
        self.assertEqual(summary["skipped"]["already_alerted"], 1)

    def test_failed_channel_is_reported_redacted_and_entries_still_marked(self):
        def boom(*a, **k):
            raise job_alerts.smtplib.SMTPAuthenticationError(
                535, f"bad credentials for {SECRETS['ALERT_SMTP_USER']}".encode()
            )

        with (
            mock.patch.object(job_alerts.smtplib, "SMTP_SSL", side_effect=boom),
            mock.patch.object(
                job_alerts.urllib.request,
                "urlopen",
                side_effect=job_alerts.urllib.error.URLError(
                    f"refused https://api.callmebot.com/whatsapp.php?apikey={SECRETS['CALLMEBOT_APIKEY']}"
                ),
            ),
        ):
            code, summary, printed = self.run_main(env=SECRETS)
        self.assertEqual(code, 0)
        self.assertEqual(summary["channels"], {"email": "failed", "whatsapp": "failed"})
        self.assertTrue(self.state.exists(), "alerts are marked even if a channel failed")
        for value in SECRETS.values():
            self.assertNotIn(value, printed)

    def test_missing_env_skips_every_channel_and_keeps_alerts_for_next_run(self):
        code, summary, printed = self.run_main(env={})
        self.assertEqual(code, 2)
        self.assertEqual(summary["channels"], {"email": "skipped", "whatsapp": "skipped"})
        self.assertFalse(self.state.exists())
        self.assertIn("email skipped", printed)

    def test_no_notify_seeds_state_without_sending(self):
        with mock.patch.object(job_alerts.smtplib, "SMTP_SSL") as smtp:
            code, summary, _ = self.run_main("--no-notify", env=SECRETS)
        self.assertEqual(code, 0)
        smtp.assert_not_called()
        self.assertTrue(self.state.exists())

    def test_whatsapp_messages_are_split_and_carry_no_secret(self):
        class Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with (
            mock.patch.object(job_alerts.urllib.request, "urlopen", return_value=Resp()) as urlopen,
            mock.patch.object(job_alerts.smtplib, "SMTP_SSL"),
        ):
            code, summary, printed = self.run_main("--test-notify", env=SECRETS)
        self.assertEqual(code, 0)
        self.assertEqual(summary["channels"], {"email": "sent", "whatsapp": "sent"})
        self.assertIn("apikey=987654", urlopen.call_args[0][0])
        self.assertNotIn("987654", printed)
        from datetime import datetime

        alerts = [
            {
                "fit": "high",
                "score": 90,
                "title": "AI Engineer " * 20,
                "company": "Acme",
                "flags": [],
                "url": f"https://jobs.test/{i}",
                "portal": "freehire-search",
                "id": "",
            }
            for i in range(5)
        ]
        messages = job_alerts.whatsapp_messages(alerts, 5, datetime(2026, 11, 11, 8, 0), max_encoded=700)
        self.assertGreater(len(messages), 1)
        self.assertTrue(all(len(job_alerts.urllib.parse.quote(m)) <= 700 for m in messages))

    def test_test_notify_without_env_fails_cleanly(self):
        code, summary, _ = self.run_main("--test-notify", env={})
        self.assertEqual(code, 1)
        self.assertEqual(summary["channels"], {"email": "skipped", "whatsapp": "skipped"})

    def test_missing_bun_is_a_clear_error(self):
        with mock.patch.object(job_alerts, "find_bun", return_value=None):
            code, summary, printed = self.run_main(env={})
        self.assertEqual(code, 1)
        self.assertIn("bun not found", summary["error"])


if __name__ == "__main__":
    unittest.main()


class CompanyCoreTests(unittest.TestCase):
    def test_legal_suffixes_do_not_hide_an_application(self):
        norm = job_alerts.norm
        self.assertEqual(job_alerts.company_core(norm("Costanera Ltd")), job_alerts.company_core(norm("Costanera")))
        self.assertEqual(job_alerts.company_core(norm("Indra Group")), "indra")
        self.assertEqual(job_alerts.company_core(norm("Sur Tecnologías S.A.C.")), norm("Sur Tecnologías"))
