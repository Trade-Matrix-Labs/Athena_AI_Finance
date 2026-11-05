"""Offline check of ask-faq-r14.json against REPORT.json (stdlib only).
Usage: python -I -B check_faq.py [faq.json] [REPORT.json]
Rebuilds the id space the App serves (adapter.adapt_v2_to_v3 + ask.index) and the text the number check sees (ask.support)."""
import collections
import json
import pathlib
import re
import sys
from decimal import Decimal

HERE = pathlib.Path(__file__).resolve().parent
FAQ = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "ask-faq-r14.json"
REPORT = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else HERE.parent / "app/fixtures/r14/REPORT.json"

MIX = {"factual": 12, "why": 4, "comparison": 2, "define_term": 2, "explain_figure": 1,
       "write_request": 1, "advice": 1, "cannot_answer": 1}
STATE = {"write_request": "needs_approval", "advice": "refused", "cannot_answer": "cannot_answer"}
STATES = {"answered", "refused", "cannot_answer", "needs_approval"}
FIELDS = {"id", "question", "category", "intent", "anchor_id", "expected_state", "expected_citation_ids_any",
          "required_numbers", "notes"}
SECTION_IDS = {"cashflow": "cash-flow", "quality": "earnings-quality", "balance": "balance-sheet"}  # adapter.py
GLOSS = re.compile(r"\*\*([^*]+?)\.\*\* ([^*]+)")  # adapter.py
TOKEN = re.compile(r"\{fact:([^}]+)\}")  # ask.py
SRC_REF = re.compile(r"\[(src-[a-z0-9-]+)\]")
SKIP_KEYS = {"id", "kind", "tone", "accession", "filing_accession", "formula", "inputs", "source", "unit", "scale"}
SCALE = {"units": 0, "thousands": 3, "millions": 6, "billions": 9}


def shown(f, quote):  # adapter.printed_form: the printed form the server gives a reported fact
    s = f["value"].lstrip("-")
    num = f"{Decimal(s):,}"
    if f["unit"] == "percent":
        core = s + "%"
    elif f["scale"] in ("millions", "billions"):
        core = ("$" if f["unit"] == "usd" else "") + f"{num} {f['scale'][:-1]}"
    else:
        core = num
    return f"({core})" if f"({core})" in " ".join(quote.split()) else core


def served(doc):
    """id -> (kind, element) for everything Ask can cite."""
    ids = {"summary": ("section", {k: v for k, v in doc["cover"].items()})}
    kpis = doc["cover"].get("kpis")
    if isinstance(kpis, dict) and kpis.get("id"):
        ids[kpis["id"]] = ("block", kpis)
    for s in doc["sections"]:
        kept = []
        for b in s["blocks"]:
            m = s["id"] == "glossary" and b.get("kind") == "prose" and not b.get("title") and GLOSS.fullmatch(b.get("text") or "")
            if m and f"**{m.group(1)}.** {m.group(2)}" == b["text"]:
                ids[b["id"]] = ("glossary", {"term": m.group(1), "definition": m.group(2)})
            else:
                kept.append(b)
        if s["id"] == "summary":
            for b in kept:
                ids[b["id"]] = ("block", b)
        elif kept:
            ids[SECTION_IDS.get(s["id"], s["id"])] = ("section", {k: v for k, v in s.items() if k != "blocks"})
            for b in kept:
                ids[b["id"]] = ("block", b)
    sources = {s["id"]: s for s in doc["sources"]}
    for s in doc["sources"]:
        ids[s["id"]] = ("source", s)
    for f in doc["facts"]:
        g = dict(f)
        if g["kind"] == "reported":
            g["shown"] = shown(g, sources[g["source"]]["quote"])
        ids[g["id"]] = ("fact", g)
    return ids


def strings(o):  # ask.strings
    if isinstance(o, dict):
        for k, v in o.items():
            if k not in SKIP_KEYS:
                yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def text_of(entry, facts):
    """Reader-visible text of an element as the number check sees it (ask.support): its strings without
    {fact:..}/[src-..] tokens, plus label, period, printed form and value of each fact it shows."""
    kind, el = entry
    shown_facts, text = ([el] if kind == "fact" else []), []
    for s in strings(el):
        if s in facts and kind != "fact":
            shown_facts.append(facts[s])
            continue
        shown_facts += [facts[t] for t in TOKEN.findall(s) if t in facts]
        text.append(SRC_REF.sub(" ", TOKEN.sub(" ", s)))
    for f in shown_facts:
        text += [f.get("label") or "", f.get("period") or "", f.get("shown") or "", f.get("value") or ""]
    return " ".join(text)


def main():
    ids = served(json.loads(REPORT.read_text()))
    facts = {k: e[1] for k, e in ids.items() if e[0] == "fact"}
    items = json.loads(FAQ.read_text())
    errs = []
    if len(items) != 24:
        errs.append(f"expected 24 items, got {len(items)}")
    if len({i.get("id") for i in items}) != len(items):
        errs.append("duplicate item ids")
    for it in items:
        n = it.get("id")
        bad = set(it) - FIELDS
        miss = FIELDS - {"intent", "anchor_id"} - set(it)
        if bad or miss:
            errs.append(f"{n}: unknown fields {sorted(bad)} / missing fields {sorted(miss)}")
            continue
        if it["expected_state"] not in STATES:
            errs.append(f"{n}: bad expected_state {it['expected_state']!r}")
        if it["category"] in STATE and it["expected_state"] != STATE[it["category"]]:
            errs.append(f"{n}: category {it['category']} must expect {STATE[it['category']]}")
        if it["category"] not in STATE and it["expected_state"] != "answered":
            errs.append(f"{n}: category {it['category']} must expect answered")
        want = it["expected_citation_ids_any"]
        if it["expected_state"] == "answered" and not want:
            errs.append(f"{n}: an answered item needs expected citation ids")
        for i in want:
            if i not in ids:
                errs.append(f"{n}: expected id {i!r} is not in the served id space")
        texts = [text_of(ids[i], facts) for i in want if i in ids]
        for num in it["required_numbers"]:
            if not any(num in t for t in texts):
                errs.append(f"{n}: required number {num!r} occurs in no expected element")
        a = it.get("anchor_id")
        if a and ids.get(a, ("",))[0] not in ("block", "fact"):
            errs.append(f"{n}: anchor_id {a!r} is not a served block or fact")
        if it["category"] == "define_term" and it.get("intent") != "define_term":
            errs.append(f"{n}: define_term items need intent define_term")
        if it["category"] == "explain_figure" and (it.get("intent") != "explain_figure" or not a):
            errs.append(f"{n}: explain_figure items need intent explain_figure and an anchor_id")
        if it["category"] == "write_request" and not a:
            errs.append(f"{n}: write_request needs an anchor_id")
    counts = collections.Counter(i["category"] for i in items)
    if dict(counts) != MIX:
        errs.append(f"category counts {dict(counts)} != {MIX}")
    prof = sum(i["category"] == "factual" and i["notes"].startswith("[profitability]") for i in items)
    if prof < 4:
        errs.append(f"only {prof} profitability factual items (need 4)")
    print(f"served ids: {len(ids)} ({collections.Counter(e[0] for e in ids.values())})")
    print(f"items: {len(items)}; categories: {dict(counts)}; profitability: {prof}")
    print(f"states: {dict(collections.Counter(i['expected_state'] for i in items))}")
    for e in errs:
        print("FAIL", e)
    print("FAIL" if errs else "OK")
    return 1 if errs else 0


sys.exit(main())
