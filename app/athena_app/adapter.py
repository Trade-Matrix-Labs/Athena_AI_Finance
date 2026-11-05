"""ReportDocument v2 -> v3 adapter.

Deterministic and conservative: it reuses the pipeline's own strings, never writes new reader text,
and refuses input it does not know how to carry over instead of dropping it.
"""
import copy
import json
import re
from decimal import Decimal

SECTION_IDS = {"cashflow": "cash-flow", "quality": "earnings-quality", "balance": "balance-sheet"}
V2_TOP = {"version", "status", "language", "filing", "cover", "sections", "facts", "sources"}
V2_SECTION = {"id", "number", "title", "lede", "blocks"}
SCALE_EXP = {"units": 0, "thousands": 3, "millions": 6, "billions": 9}
QNAME = re.compile(r"[A-Za-z][\w-]*:[A-Za-z_][\w.-]*")  # an XBRL concept name such as us-gaap:Revenues
TOKEN = re.compile(r"\{fact:([^}]+)\}")
QUOTE = re.compile(r"\{quote:([^}]+)\}")  # the filing's own words: a source's quote, set in the text at serve time
GLOSS = re.compile(r"\*\*([^*]+?)\.\*\* ([^*]+)")  # "**Term.** Definition" with no other bold run

# kept in the stored document, never sent to the client
SERVER_FACT_KEYS = ("calc", "name", "tag_ref")
CLIENT_TABLE_KEYS = ("table_ref", "accession", "column_headers", "row_headers", "rows", "omitted_before", "omitted_after")
CLIENT_CELL_KEYS = ("text", "column", "colspan", "rowspan", "header")


class AdapterError(ValueError):
    pass


def canonical(doc):
    """The stored bytes of a document: sorted keys, no whitespace, UTF-8."""
    return json.dumps(doc, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def tokens(text):
    return sorted(set(TOKEN.findall(text or "")))


def quotes(o, sources):
    """A copy of `o` with each {quote:src-id} replaced by that source's quote in typographic quotation marks (no
    citation is added: the author's own [src-id] follows). Raises, so nothing renders as a token or as markup: an
    unknown source, a quote holding "{", "[src-" or "**", and an empty or unterminated token."""
    if isinstance(o, dict):
        return {k: quotes(v, sources) for k, v in o.items()}
    if isinstance(o, list):
        return [quotes(v, sources) for v in o]
    if not isinstance(o, str) or "{quote:" not in o:
        return o

    def one(m):
        if m[1] not in sources or not isinstance(sources[m[1]].get("quote"), str):
            raise AdapterError(f"{m[0]} names no source with a quote")
        if any(t in sources[m[1]]["quote"] for t in ("{", "[src-", "**")):
            raise AdapterError(f"{m[0]}: the quote holds a token or markup")
        return "\u201c" + " ".join(sources[m[1]]["quote"].split()) + "\u201d"
    out = QUOTE.sub(one, o)
    if "{quote:" in out:
        raise AdapterError("an empty or unterminated {quote:} token")
    return out


def printed_form(fact, quote):
    """(shown, decimals) of a reported fact, from value, scale and unit; parentheses only when the quote prints them.
    The quote's own spacing wins ("1.4 %", "$ 94.6 million"): same tokens in the same order, so the digits cannot change.
    A figure the quote does not print keeps the formed string, and the checker refuses it."""
    s = fact["value"].lstrip("-")
    num = f"{Decimal(s):,}"
    if fact["unit"] == "percent":
        core = s + "%"
    elif fact["scale"] in ("millions", "billions"):
        core = ("$" if fact["unit"] == "usd" else "") + f"{num} {fact['scale'][:-1]}"
    else:
        core = num
    q = " ".join(quote.split())
    if core not in q:
        tokens = re.findall(r"[\d.,]+|[^\d.,\s]+", core)
        m = re.search(r"(?<![\d.,])" + r"\s*".join(map(re.escape, tokens)), q)  # the lookbehind: 1.4 is not in 11.4
        core = m.group(0) if m else core
    shown = f"({core})" if f"({core})" in q else core
    decimals = len(s.partition(".")[2]) - SCALE_EXP[fact["scale"]] + (2 if fact["unit"] == "percent" else 0)
    return shown, decimals


def adapt_fact(f, sources):
    g = copy.deepcopy(f)
    tag = g.pop("tag", None)
    if tag and QNAME.fullmatch(tag):
        g["concept"] = tag
    elif tag:
        g["tag_ref"] = tag  # an opaque pipeline row reference, not an XBRL name: server-side only
    if g["kind"] == "reported":
        if "shown" not in g or "decimals" not in g:
            shown, decimals = printed_form(g, sources[g["source"]]["quote"])
            g.setdefault("shown", shown)
            g.setdefault("decimals", decimals)
        if g["unit"] == "percent":  # v3 states shares of a whole as a ratio: 38 percent -> 0.38, shown "38%"
            g["unit"], g["value"] = "ratio", str(Decimal(g["value"]).scaleb(-2))
    return g


def adapt_block(b):
    if b.get("kind") != "source_table":
        return copy.deepcopy(b)
    # The Desk has no filing_table renderer yet: carry the literal filing text as prose, with the table itself
    # attached for a later renderer. Every string is the filing's own (lead-in, cell texts, footnotes).
    rows = [" ".join(c["text"] for c in row if c["text"].strip()) for row in b["rows"]]
    parts = [(b.get("before") or {}).get("text", "").strip(), *rows, (b.get("after") or {}).get("text", "").strip()]
    table = {k: copy.deepcopy(v) for k, v in b.items() if k not in ("kind", "id")}
    return {"kind": "prose", "id": b["id"], "text": "\n".join(p for p in parts if p), "filing_table": table}


def glossary_entry(b):
    """{term, definition, facts} when the block is exactly '**Term.** Definition'; otherwise None (keep the prose)."""
    m = b.get("kind") == "prose" and not b.get("title") and GLOSS.fullmatch(b.get("text") or "")
    if not m or f"**{m.group(1)}.** {m.group(2)}" != b["text"]:
        return None
    return {"id": b["id"], "term": m.group(1), "definition": m.group(2), "facts": tokens(m.group(2))}


def adapt_v2_to_v3(doc, meta):
    """meta: chapters [(id, title, question)], edition_number. Nothing here depends on the time of ingest:
    `edition.created` comes from the edition row (with_created), so the stored document hash is reproducible."""
    if doc.get("version") != 2:
        raise AdapterError(f"expected ReportDocument version 2, got {doc.get('version')!r}")
    if set(doc) - V2_TOP:
        raise AdapterError(f"unknown top-level fields {sorted(set(doc) - V2_TOP)}")
    order = {cid: (n, q) for n, (cid, _title, q) in enumerate(meta["chapters"], 1)}
    sources = {s["id"]: s for s in doc["sources"]}
    cover = copy.deepcopy(doc["cover"])
    chapters, glossary, appendix = [], [], []
    for s in doc["sections"]:
        if set(s) - V2_SECTION:
            raise AdapterError(f"section {s['id']}: unknown fields {sorted(set(s) - V2_SECTION)}")
        lede = {"keypoint": s["lede"]} if s.get("lede") else {}
        blocks = [adapt_block(b) for b in s["blocks"]]
        if s["id"] == "summary":
            cover.update({"title": s["title"], **lede, "blocks": blocks})
        elif s["id"] in ("glossary", "sources"):
            kept = []
            for b in blocks:
                g = glossary_entry(b) if s["id"] == "glossary" else None
                (glossary if g else kept).append(g or b)
            if kept:
                appendix.append({"id": s["id"], "title": s["title"], **lede, "blocks": kept})
        else:
            cid = SECTION_IDS.get(s["id"], s["id"])
            if cid not in order:
                raise AdapterError(f"section {s['id']}: no chapter mapping")
            chapters.append({"id": cid, "title": s["title"], "question": order[cid][1], **lede, "blocks": blocks})
    if len({c["id"] for c in chapters}) != len(chapters):
        raise AdapterError("two sections map to one chapter")
    chapters.sort(key=lambda c: order[c["id"]][0])
    for n, c in enumerate(chapters, 1):
        c["number"] = n
    out = {
        "version": "3", "language": doc["language"], "status": doc["status"],
        "revision": {"number": 1},
        "edition": {"scope": "shared", "number": meta["edition_number"],
                    "filing_accession": doc["filing"]["accession"]},
        "filing": copy.deepcopy(doc["filing"]), "cover": cover,
        # one entry per chapter; a chapter without a lede keeps an empty key point (nothing is written for it)
        "digest": [{"section": c["id"], "keypoint": c.get("keypoint", ""), "facts": tokens(c.get("keypoint"))}
                   for c in chapters],
        "sections": chapters, "glossary": glossary,
        "sources": copy.deepcopy(doc["sources"]),
        "facts": [adapt_fact(f, sources) for f in doc["facts"]],
    }
    if appendix:
        out["appendix"] = appendix
    quotes(out, sources)  # an unknown {quote:} source fails the ingest; the stored text keeps its tokens
    return out


def with_created(doc, created):
    """The document as readers get it: the edition row's creation time added to `edition`."""
    return {**doc, "edition": {**doc["edition"], "created": created}}


def all_blocks(doc):
    yield from doc["cover"].get("blocks", [])
    for s in doc["sections"] + doc.get("appendix", []):
        yield from s["blocks"]


def client_view(doc):
    """The document as sent to the browser (and to Ask): {quote:} tokens set as the quoted words, server-only fields,
    offsets and hashes removed."""
    out = quotes(doc, {s["id"]: s for s in doc["sources"]})  # a fresh copy
    for f in out["facts"]:
        for k in SERVER_FACT_KEYS:
            f.pop(k, None)
        if isinstance(f.get("basis"), dict):
            f["basis"] = {k: v for k, v in f["basis"].items() if not k.endswith("sha256")}
    for s in out["sources"]:
        if isinstance(s.get("excerpt"), dict):  # offsets and hashes into the filing stay server-side
            s["excerpt"] = {k: v for k, v in s["excerpt"].items()
                            if not re.search(r"(start|end|sha256)$|^coordinate_system$", k)}
    for b in all_blocks(out):
        t = b.get("filing_table")
        if t:
            t = {k: t[k] for k in CLIENT_TABLE_KEYS if k in t}
            t["rows"] = [[{k: c[k] for k in CLIENT_CELL_KEYS if k in c} for c in row] for row in t.get("rows", [])]
            b["filing_table"] = t
    return out
