"""Check report_v3.json against the 10-K inline XBRL filing. Stdlib only.

Usage: python -I -B check_report.py [report.json] [filing.htm] [--selftest]
Exit code 0 when the mismatch total is 0.
"""
import copy
import html
import json
import re
import sys
from decimal import Decimal, getcontext
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE / "report_v3.json"
FILING = HERE.parent / "inputs" / "pltr-20251231.htm"
SCALE = {"units": 0, "thousands": 3, "millions": 6, "billions": 9}
WORDS = "zero one two three four five six seven eight nine ten eleven twelve".split()
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
BLOCK = re.compile(r"<(?:/?(?:td|th|tr|p|div|li|table|h\d)\b[^>]*|br\b[^>]*)>", re.I)
TAG = re.compile(r"<[^>]+>")
# unit words the UI adds itself; none may follow a {fact:id} token of that unit
UNIT_WORDS = {
    "multiple": r"(?:times\b|x\b|×)",
    "ratio": r"(?:%|percent\b|per cent\b)",
    "points": r"(?:points?\b|pp\b|percentage points\b)",
    "shares": r"(?:\S+\s+){0,2}shares(?![\w-])",
    "usd": r"(?:thousand|million|billion|dollars?)\b",
    "usd_per_share": r"(?:per share\b|dollars?\b)",
}


def digits(s):
    return re.sub(r"[^\d.]", "", s).strip(".")


def norm(s):
    return " ".join(s.split())


def load_filing(path=FILING):
    raw = Path(path).read_text(encoding="utf-8")
    ctx = {}
    for m in re.finditer(r'<xbrli:context id="([^"]+)">(.*?)</xbrli:context>', raw, re.S):
        body = m.group(2)
        inst = re.search(r"<xbrli:instant>([^<]+)", body)
        if inst:
            per = ("instant", inst.group(1).strip())
        else:
            per = ("duration", re.search(r"<xbrli:startDate>([^<]+)", body).group(1).strip(),
                   re.search(r"<xbrli:endDate>([^<]+)", body).group(1).strip())
        dims = dict(re.findall(r'<xbrldi:explicitMember dimension="([^"]+)">([^<]+)<', body))
        dims.update(re.findall(r'<xbrldi:typedMember dimension="([^"]+)"><[^>]+>([^<]+)<', body))
        ctx[m.group(1)] = (per, dims)
    tags = []
    for m in re.finditer(r"<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>", raw, re.S):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        text = norm(html.unescape(TAG.sub("", m.group(2))))
        if a.get("format", "").endswith("fixed-zero") or text in ("-", "—"):
            num = Decimal(0)
        elif a.get("format", "").endswith("numwordsen") and text.lower() in WORDS:
            num = Decimal(WORDS.index(text.lower()))
        else:
            try:
                num = Decimal(text.replace(",", ""))
            except ArithmeticError:
                continue  # not a plain number (none is used by the report)
        num = num.scaleb(int(a.get("scale", "0")))
        if a.get("sign") == "-":
            num = -num
        per, dims = ctx[a["contextRef"]]
        dec = a.get("decimals")
        tags.append({"name": a["name"], "ctx": a["contextRef"], "period": per, "dims": dims,
                     "text": text, "value": num, "sign": a.get("sign"), "id": a.get("id"),
                     "decimals": dec if dec == "INF" else int(dec)})
    text = norm(html.unescape(TAG.sub("", BLOCK.sub(" ", raw))))
    return tags, text


def period_key(label):
    """'FY2025' -> fiscal-year duration; '31 Dec 2025' -> instant."""
    m = re.fullmatch(r"FY(\d{4})", label)
    if m:
        return ("duration", f"{m.group(1)}-01-01", f"{m.group(1)}-12-31")
    d, mon, y = label.split()
    return ("instant", f"{y}-{MONTHS.index(mon) + 1:02d}-{int(d):02d}")


def unit_dropped(shown, quote):
    """True when the quote prints unit words or parentheses around shown that shown leaves out."""
    forms = (f"${shown} billion", f"${shown} million", f"{shown} billion", f"{shown} million",
             f"{shown}%", f"{shown} %", f"({shown})")
    return not any(c in shown for c in "%()") and "billion" not in shown and "million" not in shown \
        and any(x in quote for x in forms)


def printed_decimals(shown, scale):
    """XBRL-style decimals of a printed figure: '$4.1 billion' -> -8, '109%' -> 2, '954' -> 0."""
    num = re.search(r"\d[\d,]*(?:\.(\d+))?", shown)
    return len(num.group(1) or "") - SCALE[scale] + (2 if "%" in shown else 0)


def instant_span(fid, facts):
    """'D1 to D2' when a calculated fact's leaf inputs are instants at different dates, else None."""
    leaves, todo = [], [fid]
    while todo:
        f = facts[todo.pop()]
        if f["kind"] == "calculated":
            todo += f["inputs"]
        else:
            leaves.append(f["period"])
    inst = sorted({p for p in leaves if not p.startswith("FY")}, key=period_key)
    return f"{inst[0]} to {inst[-1]}" if len(inst) > 1 else None


def fact_amount(f):
    return Decimal(f["value"]) * Decimal(10) ** SCALE[f["scale"]]  # plain digits, no exponent


def evaluate(formula, env):
    """Evaluate + - * / ( ) over fact ids with Decimal prec 28."""
    toks = re.findall(r"[A-Za-z][\w-]*[\w]|[A-Za-z]|\d+(?:\.\d+)?|[-+*/()]", formula)
    if norm(formula).replace(" ", "") != "".join(toks):
        raise ValueError(f"bad token in {formula!r}")
    pos = 0

    def peek():
        return toks[pos] if pos < len(toks) else None

    def take():
        nonlocal pos
        pos += 1
        return toks[pos - 1]

    def atom():
        t = take()
        if t == "(":
            v = expr()
            if take() != ")":
                raise ValueError("missing )")
            return v
        if t == "-":
            return -atom()
        if re.fullmatch(r"\d+(?:\.\d+)?", t):
            return Decimal(t)
        return env[t]

    def term():
        v = atom()
        while peek() in ("*", "/"):
            v = v * atom() if take() == "*" else v / atom()
        return v

    def expr():
        v = term()
        while peek() in ("+", "-"):
            v = v + term() if take() == "+" else v - term()
        return v

    v = expr()
    if pos != len(toks):
        raise ValueError(f"trailing tokens in {formula!r}")
    return v


def formula_ids(formula):
    return [t for t in re.findall(r"[A-Za-z][\w-]*[\w]|[A-Za-z]", formula)]


def check(report, tags, text):
    getcontext().prec = 28
    errs = []
    facts = {f["id"]: f for f in report["facts"]}
    sources = {s["id"]: s for s in report["sources"]}
    assumptions = {a["id"] for a in report.get("assumptions", [])}
    n = {"reported_tagged": 0, "reported_text": 0, "calculated": 0}
    if len(facts) != len(report["facts"]):
        errs.append("duplicate fact ids")
    ed = report.get("edition") or {}
    if ed.get("scope") != "shared" or ed.get("filing_accession") != report["filing"]["accession"] \
            or not isinstance(ed.get("number"), int) or not ed.get("created"):
        errs.append(f"edition: missing or inconsistent {ed}")

    # (3) source quotes appear verbatim in the filing text
    for s in report["sources"]:
        if norm(s["quote"]) not in text:
            errs.append(f"{s['id']}: quote not found in filing")
        if len(s["quote"]) > 260:
            errs.append(f"{s['id']}: quote longer than 260 chars")
        if s["accession"] != report["filing"]["accession"]:
            errs.append(f"{s['id']}: accession differs")

    # (1) reported facts, (2) calculated facts
    env = {}

    def amount(fid, stack=()):
        if fid in env:
            return env[fid]
        f = facts[fid]
        if f["kind"] == "reported":
            env[fid] = fact_amount(f)
        else:
            if fid in stack:
                raise ValueError(f"cycle at {fid}")
            for i in formula_ids(f["formula"]):
                amount(i, stack + (fid,))
            env[fid] = evaluate(f["formula"], env)
        return env[fid]

    for f in report["facts"]:
        fid = f["id"]
        if f["kind"] == "reported" and "decimals" not in f:
            errs.append(f"{fid}: reported fact without decimals")
        if f["kind"] == "calculated" and "decimals" in f:
            errs.append(f"{fid}: calculated fact carries decimals")
        if f["kind"] == "reported":
            src = sources.get(f["source"])
            if src is None:
                errs.append(f"{fid}: source {f['source']} missing")
                continue
            shown = f.get("shown")
            if shown is not None and shown not in norm(src["quote"]):
                errs.append(f"{fid}: shown {shown!r} not in {src['id']} quote")
            elif shown is not None and unit_dropped(shown, norm(src["quote"])):
                errs.append(f"{fid}: shown {shown!r} drops unit words printed in {src['id']}")
            word = next((w for w in ("billion", "million") if w in (shown or "")), None)
            if word and f["scale"] != word + "s":
                errs.append(f"{fid}: shown {shown!r} says {word} but scale is {f['scale']}")
            if f.get("concept"):
                n["reported_tagged"] += 1
                key = period_key(f.get("context_period") or f["period"])
                dims = f.get("dims") or {}
                hits = [t for t in tags if t["name"] == f["concept"] and t["period"] == key
                        and t["dims"] == dims]
                if not hits:
                    errs.append(f"{fid}: no tag {f['concept']} {f['period']} {dims}")
                    continue
                # a concept/period can be tagged twice (exact table value and a rounded text
                # value); the fact must equal one of them and its shown text must be that tag's
                same = [t for t in hits if t["value"] == fact_amount(f)]
                if not same:
                    errs.append(f"{fid}: value {fact_amount(f)} != filing "
                                f"{sorted({t['value'] for t in hits})}")
                elif shown is not None and not any(digits(shown) == digits(t["text"]) for t in same):
                    errs.append(f"{fid}: shown {shown!r} differs from tag text")
                elif not any(t["decimals"] == f.get("decimals") and digits(shown or "") == digits(t["text"])
                             for t in same):
                    errs.append(f"{fid}: decimals {f.get('decimals')!r} != filing "
                                f"{sorted({str(t['decimals']) for t in same})}")
            else:
                n["reported_text"] += 1
                if not shown:
                    errs.append(f"{fid}: untagged fact needs 'shown'")
                    continue
                num = Decimal(digits(shown)) / (100 if shown.endswith("%") else 1)
                if num != abs(Decimal(f["value"])):
                    errs.append(f"{fid}: shown {shown!r} != value {f['value']} {f['scale']}")
                if f.get("decimals") != printed_decimals(shown, f["scale"]):
                    errs.append(f"{fid}: decimals {f.get('decimals')!r} != printed precision "
                                f"{printed_decimals(shown, f['scale'])} of {shown!r}")
        elif f["kind"] == "calculated":
            n["calculated"] += 1
            try:
                ids = formula_ids(f["formula"])
                if sorted(set(ids)) != sorted(set(f["inputs"])):
                    errs.append(f"{fid}: inputs {f['inputs']} != formula ids {ids}")
                env.pop(fid, None)
                v = amount(fid)
            except (KeyError, ValueError, ArithmeticError) as e:
                errs.append(f"{fid}: cannot evaluate ({e!r})")
                continue
            if f["scale"] != "units" or str(v) != f["value"]:
                errs.append(f"{fid}: value {f['value']} != recomputed {v}")
            span = instant_span(fid, facts)
            if span and f["period"] != span:
                errs.append(f"{fid}: period {f['period']!r} should name both dates, {span!r}")
        else:
            errs.append(f"{fid}: unknown kind {f['kind']}")

    # (4) structure
    used = set()
    src_used = set()

    def refs(s, where):
        for m in re.finditer(r"\{fact:([^}]+)\}", s or ""):
            fid = m.group(1)
            used.add(fid)
            if fid not in facts:
                errs.append(f"{where}: unknown fact {fid}")
                continue
            # lint: the UI renders the unit, so no unit word may follow the token, and prose
            # uses direction words with absolute values (tables keep the printed sign)
            f, after = facts[fid], s[m.end():]
            pat = UNIT_WORDS.get(f["unit"])
            if pat and re.match(r"\s*" + pat, after, re.I):
                errs.append(f"{where}: LINT unit words after {fid}: {after[:30]!r}")
            if f["unit"] in ("usd", "usd_per_share") and s[:m.start()].endswith("$"):
                errs.append(f"{where}: LINT '$' before {fid}")
            if Decimal(f["value"]) < 0:
                errs.append(f"{where}: LINT negative value {fid} in prose")
        if re.search(r"\[\[|\]\]", s or ""):
            errs.append(f"{where}: LINT doubled brackets around a source marker")
        for sid in re.findall(r"\[(src-\d+)\]", s or ""):
            src_used.add(sid)
            if sid not in sources:
                errs.append(f"{where}: unknown source {sid}")

    def need(fid, where):
        if fid is None:
            return
        used.add(fid)
        if fid not in facts:
            errs.append(f"{where}: unknown fact {fid}")

    def block(b, where):
        k = b["kind"]
        where = f"{where}/{b.get('id')}"
        for key in ("text", "title", "caption", "subtitle"):
            refs(b.get(key), where)
        if k == "table":
            for r in b["rows"]:
                if len(r["cells"]) != len(b["columns"]):
                    errs.append(f"{where}: row {r['label']} width")
                for c in r["cells"]:
                    need(c, where)
                refs(r.get("note"), where)
        elif k == "chart":
            for s in b["series"]:
                if len(s["facts"]) != len(b["periods"]):
                    errs.append(f"{where}: series {s['label']} length")
                for c in s["facts"]:
                    need(c, where)
        elif k == "kpis":
            for it in b["items"]:
                refs(it.get("note"), where)
                for key in ("fact", "delta", "compare"):
                    need(it.get(key), where)
        elif k == "lab":
            for i in b["inputs"]:
                if i not in assumptions:
                    errs.append(f"{where}: unknown assumption {i}")
            for o in b["outputs"]:
                ids = formula_ids(o["formula"])
                if sorted(set(ids)) != sorted(set(o["inputs"])):
                    errs.append(f"{where}: lab output {o['label']} inputs mismatch")
                for i in o["inputs"]:
                    if i in assumptions:
                        continue
                    need(i, where)
                try:
                    probe = {i: Decimal(50) if i in assumptions else amount(i) for i in o["inputs"]}
                    evaluate(o["formula"], probe)
                except (KeyError, ValueError, ArithmeticError) as e:
                    errs.append(f"{where}: lab output {o['label']} fails ({e!r})")
        elif k in ("prose", "callout"):
            if not b.get("text"):
                errs.append(f"{where}: empty text")
        else:
            errs.append(f"{where}: unknown block kind {k}")

    cover = report["cover"]
    refs(cover["headline"], "cover")
    refs(cover["standfirst"], "cover")
    block(cover["kpis"], "cover")
    if cover.get("chart"):
        block(cover["chart"], "cover")
    secs = report["sections"]
    for i, s in enumerate(secs, 1):
        w = f"section {s.get('id')}"
        if s.get("number") != i:
            errs.append(f"{w}: number {s.get('number')} != {i}")
        for key in ("question", "keypoint"):
            if not s.get(key):
                errs.append(f"{w}: missing {key}")
        refs(s.get("keypoint"), w)
        if not s.get("blocks"):
            errs.append(f"{w}: no blocks")
        for b in s.get("blocks", []):
            block(b, w)
    dig = report["digest"]
    if [d["section"] for d in dig] != [s["id"] for s in secs]:
        errs.append("digest: not one entry per section in order")
    for d, s in zip(dig, secs):
        refs(d["keypoint"], f"digest {d['section']}")
        for fid in d["facts"]:
            need(fid, f"digest {d['section']}")
        if sorted(set(re.findall(r"\{fact:([^}]+)\}", d["keypoint"]))) != sorted(set(d["facts"])):
            errs.append(f"digest {d['section']}: facts list differs from keypoint tokens")
    for g in report["glossary"]:
        refs(g["definition"], f"glossary {g['term']}")
        for fid in g.get("facts", []):
            need(fid, f"glossary {g['term']}")
    # calculated inputs count as used
    for f in report["facts"]:
        if f["kind"] == "calculated":
            used.update(f["inputs"])
        else:
            src_used.add(f["source"])
    orphans = sorted(set(facts) - used)
    orphan_src = sorted(set(sources) - src_used)
    return n, errs, orphans, orphan_src


def section_counts(report):
    """Facts each sheet shows directly (tokens, cells, series, lab inputs)."""
    ids = {f["id"] for f in report["facts"]}
    out = {"cover": len({w for w in re.findall(r"[\w-]+", json.dumps(report["cover"])) if w in ids})}
    for s in report["sections"]:
        out[f"{s['number']:02d} {s['id']}"] = len({w for w in re.findall(r"[\w-]+", json.dumps(s)) if w in ids})
    return out


def selftest(report, tags, text):
    """Alter a reported value, a calculated value, a quote, a prose unit and a decimals; each must be caught."""
    bad = copy.deepcopy(report)
    rep = next(f for f in bad["facts"] if f["id"] == "private-sec-fy2025")
    rep["value"] = str(Decimal(rep["value"]) + 1)
    calc = next(f for f in bad["facts"] if f["id"] == "fcf-fy2025")
    calc["value"] = str(Decimal(calc["value"]) + 1)
    src = next(s for s in bad["sources"] if s["label"] == "Revenue growth risk")
    src["quote"] = src["quote"].replace("sustain", "maintain")
    rpo = next(f for f in bad["facts"] if f["id"] == "rpo-fy2025")
    rpo["decimals"] = -3
    sec = next(s for s in bad["sections"] if s["id"] == "earnings-quality")
    sec["keypoint"] = sec["keypoint"].replace("{fact:ocf-to-ni-fy2025}", "{fact:ocf-to-ni-fy2025} times")
    _, errs, _, _ = check(bad, tags, text)
    want = {"private-sec-fy2025: value": False, "fcf-fy2025: value": False,
            f"{src['id']}: quote not found": False,
            "section earnings-quality: LINT unit words after ocf-to-ni-fy2025": False,
            "rpo-fy2025: decimals": False}
    for e in errs:
        for k in want:
            if e.startswith(k):
                want[k] = True
    print(f"selftest: altered reported private-sec-fy2025 (+1), calculated fcf-fy2025 (+1), "
          f"{src['id']} quote ('sustain' -> 'maintain'), earnings-quality keypoint ('times' after a multiple), "
          f"rpo-fy2025 decimals (-8 -> -3)")
    for e in errs:
        print("  caught:", e)
    ok = all(want.values())
    print(f"selftest: {len(errs)} mismatches raised; all five alterations caught: {ok}")
    return 0 if ok else 1


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    argv = [argv[0]] + args + [a for a in argv[1:] if a.startswith("--")]
    report = json.loads(Path(args[0] if args else REPORT).read_text(encoding="utf-8"))
    tags, text = load_filing(args[1] if len(args) > 1 else FILING)
    if "--selftest" in argv:
        return selftest(report, tags, text)
    n, errs, orphans, orphan_src = check(report, tags, text)
    print(f"filing: {len(tags)} ix:nonFraction tags, {len(text)} chars of text")
    print(f"sections {len(report['sections'])} · digest {len(report['digest'])} · "
          f"facts {len(report['facts'])} · sources {len(report['sources'])} · "
          f"glossary {len(report['glossary'])} · assumptions {len(report.get('assumptions', []))}")
    print(f"reported (tagged) {n['reported_tagged']} · reported (text) {n['reported_text']} · "
          f"calculated {n['calculated']}")
    print("facts shown per sheet: " + " · ".join(f"{k} {v}" for k, v in section_counts(report).items()))
    for e in errs:
        print("MISMATCH", e)
    print(f"orphan facts {len(orphans)}: {', '.join(orphans) or '-'}")
    print(f"orphan sources {len(orphan_src)}: {', '.join(orphan_src) or '-'}")
    print(f"mismatches: {len(errs)}")
    return 0 if not errs else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
