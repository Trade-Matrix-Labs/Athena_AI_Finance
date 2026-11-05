"""Ask eval runner.

    python -m athena_app.ask_eval [--questions <file.json>] --db <app db> --edition <id> --out <results.json> [--live]

Each question goes through the App's own POST /api/editions/{id}/ask (in process, one eval reader, a new thread per
question). Without --live a dry-run fake model answers and nothing leaves the machine: the App DB is copied to a temporary
folder with its own agent file, so the given DB and the real ledger stay untouched; such a run checks the question file,
the routing (scope guard, quick actions) and the scoring, not answer quality. With --live the configured model answers
(--ask-config or ATHENA_ASK_CONFIG, MODEL_API_KEY, ASK_COST_CAP_USD) under the cumulative cost cap of the agent file, and
the eval threads stay in --db as one eval reader's overlays. Writes are never approved: needs_approval is a match when it
is the expected state. The run stops at the first answer outside CONTINUE: any other HTTP status or code, such as
cost_cap_reached, model_auth_failed, model_error, model_timeout, model_busy, model_not_allowed, contributor_refused,
model_output_limit, model_content_filter or ask_failed (later questions are `not_run`; totals.stopped_by names it). The
results file is created new ('x') and is written also when the run stops or a question fails in the runner itself; an
existing file is never overwritten. The offline run is never traced, whatever LANGSMITH_TRACING says.

Question file: a JSON list of {id, question, category, intent?, anchor_id?, expected_state (answered | refused |
cannot_answer | needs_approval), expected_citation_ids_any, required_numbers, notes}.
"""
import argparse
import contextlib
import hashlib
import itertools
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import time

from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from pydantic import SecretStr

from . import ask
from .server import create_app

HERE = pathlib.Path(__file__).resolve().parents[2]
# the App has one refusal state for both: advice and forecasts (scope guard or model), and questions the filing can't answer
EXPECT = {"answered": "answered", "refused": "refused", "cannot_answer": "refused", "needs_approval": "needs_approval"}
# the outcomes after which the next question is asked (model_turn_limit is one question's 502); any other stops the run
CONTINUE = {"answered", "unverified", "refused", "needs_approval", "model_turn_limit"}
DEFINITIONS = {
    "verified_rate": "answered / (answered + unverified): of the answers the model gave, the share that passed the code "
                     "checks (every cited id exists, every figure supported by a cited element)",
    "citation_match_rate": "over items with expected_citation_ids_any: the share citing at least one expected id",
    "state_match_rate": "over items run: actual state == expected (cannot_answer and refused both expect refused)",
    "required_numbers_rate": "over items with required_numbers: the share whose answer holds every one, as printed "
                             "(after {fact:id} tokens are set to their printed form) or as a figure the number check "
                             "rounds to the fact printed that way",
    "cost_usd": "settled cost per the ledger; a call with an unknown outcome counts at its ceiling (cost_unknown)",
}


class DryRun(GenericFakeChatModel):
    """The offline model: one fixed answer that cites nothing (so it never verifies), with zero usage."""

    def bind_tools(self, tools, **kw):
        return self


def dry_run():
    text = json.dumps({"answer": "Dry run: no model was asked.", "citations": [], "cant_answer": False})
    usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    return DryRun(messages=(AIMessage(text, usage_metadata=usage) for _ in itertools.count()))


def offline_config(db, model=dry_run):
    """A live-shaped config whose model is a local fake: no key, no network, its own agent file next to `db`."""
    return {"model": "muse-spark-1.3", "key": SecretStr(""), "cap_usd": 1.0, "base_url": ask.BASE_URL,
            "responses_api": False, "prices": dict(ask.PRICES), **ask.INTS, "tracing": False,
            "agent_db": pathlib.Path(f"{db}.ask.sqlite"), "chat_model": lambda cfg: model()}


def calls_since(agent_db, after):
    with contextlib.closing(ask.ledger(agent_db)) as conn:
        rows = conn.execute("SELECT input_tokens, cached_tokens, output_tokens, cost_usd, ceiling_usd, status "
                            "FROM ask_model_calls WHERE id > ?", (after,)).fetchall()
    return {"model_calls": len(rows), "input_tokens": sum(r[0] or 0 for r in rows),
            "cached_tokens": sum(r[1] or 0 for r in rows), "output_tokens": sum(r[2] or 0 for r in rows),
            "cost_usd": sum(r[4] if r[5] in ask.HELD else r[3] or 0 for r in rows),
            "cost_unknown": any(r[5] in ask.HELD for r in rows)}


def last_call(agent_db):
    with contextlib.closing(ask.ledger(agent_db)) as conn:
        return conn.execute("SELECT COALESCE(MAX(id), 0) FROM ask_model_calls").fetchone()[0]


def present(n, answer, facts):
    """A required number is in the answer as the report prints it, or as a figure the number check matches to the fact
    printed that way (e.g. "$1.63 billion" for net income printed 1,634,644 thousand)."""
    if n in ask.TOKEN.sub(lambda m: (facts.get(m[1]) or {}).get("shown") or m[0], answer):
        return True
    printed = [f for f in facts.values() if n in (f.get("shown") or "")]
    return any(ask.supported(m, set(), printed) for m in ask.NUMBER.finditer(ask.NOT_FIGURE.sub(" ", ask.plain(answer))))


def rate(hits, of):
    return round(hits / of, 4) if of else None


def run(items, db, edition, cfg, ui):
    c = TestClient(create_app(db, ui, ask_config=cfg), base_url="http://127.0.0.1", raise_server_exceptions=False,
                   headers={"content-type": "application/json"})
    r = c.get(f"/api/reports/{edition}")
    if r.status_code != 200:
        raise SystemExit(f"edition {edition}: HTTP {r.status_code}")
    facts = {f["id"]: f for f in r.json()["document"]["facts"]}
    rows, stopped = [], None
    for it in items:
        if stopped:
            rows.append({"id": it["id"], "state": "not_run"})
            continue
        before, t0 = last_call(cfg["agent_db"]), time.monotonic()
        try:
            r = c.post(f"/api/editions/{edition}/ask",
                       json={"question": it["question"], **{k: it[k] for k in ("intent", "anchor_id") if it.get(k)}})
            ms = int((time.monotonic() - t0) * 1000)
            out = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            state = out.get("state", "error") if r.status_code == 200 else "error"
            cited, want = [x["id"] for x in out.get("citations", [])], it.get("expected_citation_ids_any") or []
            missing = [n for n in it.get("required_numbers") or [] if not present(n, out.get("answer") or "", facts)]
            rows.append({
                "id": it["id"], "category": it.get("category"), "expected_state": it["expected_state"], "state": state,
                "http_status": r.status_code, "code": out.get("code"),
                "state_match": state == EXPECT[it["expected_state"]], "verified": state == "answered",
                "problems": out.get("problems", []), "cited_ids": cited,
                "citation_match": bool(set(cited) & set(want)) if want else None,
                "required_numbers_present": not missing if it.get("required_numbers") else None,
                "required_numbers_missing": missing,
                "pending_tools": [p["tool"] for p in out.get("pending_actions", [])], "answer": out.get("answer"),
                **calls_since(cfg["agent_db"], before), "latency_ms": ms})
            key = state if r.status_code == 200 else out.get("code") or f"http_{r.status_code}"
            stopped = None if key in CONTINUE else key
        except (Exception, KeyboardInterrupt) as e:  # the runner's own failure: the rows so far are kept
            stopped = f"eval_{type(e).__name__}"
            rows.append({"id": it["id"], "category": it.get("category"), "expected_state": it["expected_state"],
                         "state": "error", "code": stopped, "state_match": False,
                         **calls_since(cfg["agent_db"], before)})
    ran = [x for x in rows if x["state"] != "not_run"]
    answers = [x for x in ran if x["state"] in ("answered", "unverified")]
    cites = [x for x in ran if x.get("citation_match") is not None]
    nums = [x for x in ran if x.get("required_numbers_present") is not None]
    totals = {"questions": len(items), "run": len(ran), "stopped_by": stopped,
              "states": {s: sum(x["state"] == s for x in ran) for s in sorted({x["state"] for x in ran})},
              "verified_rate": rate(sum(x["verified"] for x in answers), len(answers)),
              "citation_match_rate": rate(sum(x["citation_match"] for x in cites), len(cites)),
              "state_match_rate": rate(sum(x["state_match"] for x in ran), len(ran)),
              "required_numbers_rate": rate(sum(x["required_numbers_present"] for x in nums), len(nums)),
              **{k: sum(x[k] for x in ran) for k in ("model_calls", "input_tokens", "cached_tokens", "output_tokens")},
              "cost_usd": round(sum(x["cost_usd"] for x in ran), 6), "cost_unknown": any(x["cost_unknown"] for x in ran)}
    return {"items": rows, "totals": totals, "definitions": DEFINITIONS}


def load_items(path):
    items = json.loads(pathlib.Path(path).read_text())
    if not isinstance(items, list) or not items or not all(
            isinstance(x, dict) and isinstance(x.get("id"), str) and isinstance(x.get("question"), str)
            and x.get("expected_state") in EXPECT for x in items) or len({x["id"] for x in items}) != len(items):
        raise SystemExit(f"{path}: expected a list of {{id, question, expected_state, ...}} with unique ids")
    return items


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m athena_app.ask_eval", description=__doc__.split("\n\n")[0])
    p.add_argument("--questions", default=str(HERE / "eval" / "ask-faq-r14.json"))
    p.add_argument("--db", required=True)
    p.add_argument("--edition", type=int, required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--live", action="store_true", help="ask the configured model (paid; under ASK_COST_CAP_USD)")
    p.add_argument("--ask-config", default=os.environ.get("ATHENA_ASK_CONFIG"))
    p.add_argument("--ui", default=os.environ.get("ATHENA_UI") or str(HERE / "ui"))
    a = p.parse_args(argv)
    items, out = load_items(a.questions), pathlib.Path(a.out)
    if out.exists():
        raise SystemExit(f"{out} exists; results are never overwritten")
    if not pathlib.Path(a.db).is_file():
        raise SystemExit(f"{a.db}: no such App DB")
    with tempfile.TemporaryDirectory() as tmp:
        if a.live:
            cfg = ask.load_config(a.ask_config, a.db)
            if not cfg:
                raise SystemExit("live answers are off: --ask-config needs enabled true, a key (MODEL_API_KEY or "
                                 "key_file) and a cost cap (ASK_COST_CAP_USD or cost_cap_usd)")
            db = a.db
        else:
            db = pathlib.Path(tmp) / "athena.db"
            ro = pathlib.Path(a.db).resolve().as_uri() + "?mode=ro"  # a name with ?, # or % stays part of the path
            with contextlib.closing(sqlite3.connect(ro, uri=True)) as src, \
                    contextlib.closing(sqlite3.connect(db)) as dst:
                src.backup(dst)
            cfg = offline_config(db)
        res = run(items, db, a.edition, cfg, a.ui)
    res = {"mode": "live" if a.live else "offline-dry-run", "model": cfg["model"] if a.live else "dry-run fake",
           "edition_id": a.edition, "questions": str(a.questions),
           "questions_sha256": hashlib.sha256(pathlib.Path(a.questions).read_bytes()).hexdigest(), **res}
    with open(out, "x", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    t = res["totals"]
    print(f"{out}: {t['run']}/{t['questions']} run, verified {t['verified_rate']}, citations {t['citation_match_rate']}, "
          f"states {t['state_match_rate']}, cost ${t['cost_usd']:.4f}", file=sys.stderr)


if __name__ == "__main__":
    main()
