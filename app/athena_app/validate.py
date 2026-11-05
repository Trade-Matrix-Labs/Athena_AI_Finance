"""Run the report checker (check_report.py, loaded from its own file) on an adapted v3 document."""
import copy
import functools
import importlib.util
import json
import re
import sys

from .adapter import TOKEN, all_blocks, tokens


def load_module(path, name):
    """Import a module from a file without writing bytecode next to it."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


@functools.lru_cache(maxsize=4)
def checker_and_filing(checker_path, filing_path):
    mod = load_module(checker_path, "athena_check_report")
    tags, text = mod.load_filing(filing_path)
    return mod, tags, text


SLUG = r"[a-z0-9][a-z0-9-]*"
REPR = r"""(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")"""  # a Python string literal, as the checker prints it


# Checker style findings that do not refuse: stored with the edition as open review findings.
# Every other checker message is an integrity error and refuses the whole delivery. Each pattern spells out the
# whole message (slug ids, closed string literals, known glossary terms), so no other message can pass as one.
def review_patterns(glossary_terms=()):
    terms = "|".join(map(re.escape, glossary_terms)) or "(?!)"
    loc = rf"(?:cover|(?:section|digest) ~?{SLUG}|glossary (?:{terms}))(?:/{SLUG})?"
    return [
        ("quote length", re.compile(rf"{SLUG}: quote longer than \d+ chars")),
        ("period naming", re.compile(rf"{SLUG}: period {REPR} should name both dates, {REPR}")),
        ("sign wording", re.compile(rf"{loc}: LINT negative value {SLUG} in prose")),
        ("unit wording", re.compile(rf"{loc}: LINT unit words after {SLUG}: {REPR}")),
        ("unit wording", re.compile(rf"{loc}: LINT '\$' before {SLUG}")),
    ]


def classify(message, glossary_terms=()):
    return next((label for label, rx in review_patterns(tuple(glossary_terms)) if rx.fullmatch(message)), None)


def id_errors(doc):
    """Ids and fact references that are not plain slugs. Checked before the checker runs: ids end up inside its
    messages, so a free-form id could make an integrity error read like a review finding."""
    named = [("fact id", f.get("id")) for f in doc["facts"]] + [("source id", s.get("id")) for s in doc["sources"]]
    named += [("section id", s.get("id")) for s in doc["sections"] + doc.get("appendix", [])]
    named += [("block id", b.get("id")) for b in all_blocks(doc)]
    named += [("block id", doc["cover"][k].get("id")) for k in ("kpis", "chart") if isinstance(doc["cover"].get(k), dict)]
    named += [("glossary entry id", g.get("id")) for g in doc.get("glossary", [])]
    named += [("fact reference", t) for t in TOKEN.findall(json.dumps(doc, ensure_ascii=False))]
    return [f"{kind} {x!r} is not a plain slug" for kind, x in named
            if not (isinstance(x, str) and re.fullmatch(SLUG, x))]


def filing_table_errors(doc, text, norm):
    """A block carried over from a filing table must quote the filing: its lead-in, each joined row and its
    closing text (a quote not found in the filing is an integrity error)."""
    errors = []
    for b in all_blocks(doc):
        t = b.get("filing_table")
        if not t:
            continue
        lines = [(t.get("before") or {}).get("text", ""), (t.get("after") or {}).get("text", "")]
        lines += [" ".join(c["text"] for c in row if c["text"].strip()) for row in t.get("rows", [])]
        errors += [f"{b['id']}: filing table text not found in filing: {norm(x)[:60]!r}"
                   for x in lines if norm(x) and norm(x) not in text]
    return errors


def validate(doc, checker_path, filing_path):
    """Return (errors, findings, info). Any error refuses the ingest; findings are stored as open review findings.

    The checker sees the whole document plus the prose the app keeps outside chapters (cover blocks,
    appendix), each wrapped as an extra check-only section so its tokens and markers are checked too.
    A chapter whose v2 lede was empty has no key point (the adapter writes none); that is a review
    finding too.
    """
    mod, tags, text = checker_and_filing(str(checker_path), str(filing_path))
    bad = id_errors(doc)
    if bad:
        return bad, [], {}
    view = copy.deepcopy(doc)
    extra = [("cover", doc["cover"].get("keypoint"), doc["cover"].get("blocks", []))]
    extra += [(f"appendix-{a['id']}", a.get("keypoint"), a["blocks"]) for a in doc.get("appendix", [])]
    for sid, kp, blocks in extra:
        if not blocks:
            continue
        sid = "~" + sid
        view["sections"].append({"id": sid, "number": len(view["sections"]) + 1, "question": "~",
                                 "keypoint": kp or "~", "blocks": blocks})
        view["digest"].append({"section": sid, "keypoint": kp or "~", "facts": tokens(kp)})
    n, errs, orphans, orphan_src = mod.check(view, tags, text)
    no_kp = {f"section {s['id']}: missing keypoint" for s in doc["sections"] if "keypoint" not in s}
    errors, findings = filing_table_errors(doc, text, mod.norm), []
    terms = tuple(g["term"] for g in doc.get("glossary", []))
    for e in errs:
        label = "key point" if e in no_kp else classify(e, terms)
        if label:
            findings.append({"class": label, "message": e, "status": "open"})
        else:
            errors.append(e)
    info = {"counts": n, "orphan_facts": orphans, "orphan_sources": orphan_src}
    return errors, findings, info
