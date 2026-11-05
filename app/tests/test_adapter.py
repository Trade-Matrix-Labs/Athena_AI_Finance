"""Adapter rules on the real R14 delivery."""
import copy
import json
from decimal import Decimal

import pytest

from athena_app.adapter import SECTION_IDS, AdapterError, adapt_v2_to_v3, canonical, client_view, printed_form, quotes
from athena_app.adapter import with_created
from athena_app.validate import validate
from conftest import CHECKER, FILING, FIXTURE, META

CHAPTER_SECTIONS = 13
PCT = {"value": "1.4", "unit": "percent", "scale": "units"}


def test_shown_keeps_the_filings_spacing():
    assert printed_form(PCT, "a rate of 1.4 % in 2025")[0] == "1.4 %"
    assert printed_form(PCT, "a rate of (1.4 %) in 2025")[0] == "(1.4 %)"
    assert printed_form(PCT, "a rate of 1.4% in 2025")[0] == "1.4%"
    usd = {"value": "94.6", "unit": "usd", "scale": "millions"}
    assert printed_form(usd, "up by $ 94.6 million")[0] == "$ 94.6 million"


@pytest.mark.parametrize("quote", ["a rate of 11.4 % in 2025", "a rate of 2.4 % in 2025", "1,1.4 %", "no figure here"])
def test_shown_never_borrows_other_digits(quote):
    assert printed_form(PCT, quote)[0] == "1.4%"


def test_a_figure_absent_from_its_quote_stays_refused(v2, chapters):
    doc = copy.deepcopy(v2)
    f = next(f for f in doc["facts"] if f["kind"] == "reported" and f["unit"] == "percent")
    f["value"] = "99.97"
    errors, _, _ = validate(with_created(adapt_v2_to_v3(doc, {**META, "chapters": chapters}), "2026-11-04T00:00:00Z"),
                            CHECKER, FILING)
    assert f"{f['id']}: shown '99.97%' not in {f['source']} quote" in errors


def leaves(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from leaves(v)
    elif isinstance(o, list):
        for v in o:
            yield from leaves(v)
    elif isinstance(o, str):
        yield o


def norm(s):
    return " ".join(s.split())


def test_deterministic(v2, chapters):
    meta = {**META, "chapters": chapters}
    a = canonical(adapt_v2_to_v3(v2, meta))
    shuffled = json.loads(json.dumps(v2, sort_keys=True))  # same content, different key order
    assert a == canonical(adapt_v2_to_v3(copy.deepcopy(v2), meta)) == canonical(adapt_v2_to_v3(shuffled, meta))
    assert v2 == json.loads((FIXTURE / "REPORT.json").read_bytes())  # input untouched


def test_counts_in_and_out(v2, v3):
    assert len(v2["facts"]) == len(v3["facts"]) == 125
    assert [f["id"] for f in v2["facts"]] == [f["id"] for f in v3["facts"]]
    assert v2["sources"] == v3["sources"] and len(v3["sources"]) == 84
    assert len(v2["sections"]) == 16 and len(v3["sections"]) == CHAPTER_SECTIONS
    blocks_in = sum(len(s["blocks"]) for s in v2["sections"])
    blocks_out = (len(v3["cover"]["blocks"]) + sum(len(s["blocks"]) for s in v3["sections"])
                  + sum(len(a["blocks"]) for a in v3.get("appendix", [])) + len(v3["glossary"]))
    assert blocks_in == blocks_out == 63
    assert len(v3["glossary"]) == 16 and [a["id"] for a in v3["appendix"]] == ["sources"]


def test_keypoint_is_lede_or_absent(v2, v3):
    out = {s["id"]: s for s in v3["sections"]}
    digest = {d["section"]: d for d in v3["digest"]}
    for s in v2["sections"]:
        if s["id"] in ("summary", "glossary", "sources"):
            continue
        sec = out[SECTION_IDS.get(s["id"], s["id"])]
        if s["lede"]:
            assert sec["keypoint"] == s["lede"] == digest[sec["id"]]["keypoint"]
        else:
            assert "keypoint" not in sec and digest[sec["id"]]["keypoint"] == ""
    assert v3["cover"]["keypoint"] == v2["sections"][0]["lede"]
    assert [d["section"] for d in v3["digest"]] == [s["id"] for s in v3["sections"]]


def test_question_title_and_order(v2, v3, chapters):
    want = {cid: (n, q) for n, (cid, _t, q) in enumerate(chapters, 1)}
    titles = {SECTION_IDS.get(s["id"], s["id"]): s["title"] for s in v2["sections"]}
    for n, s in enumerate(v3["sections"], 1):
        assert s["number"] == n and s["question"] == want[s["id"]][1]
        assert s["title"] == titles[s["id"]]  # the pipeline's own title, unchanged
    assert [s["id"] for s in v3["sections"]] == [c[0] for c in chapters]


def test_no_reader_text_dropped(v2, v3):
    texts = {b["id"]: b for b in
             list(v3["cover"]["blocks"]) + [b for s in v3["sections"] + v3["appendix"] for b in s["blocks"]]}
    gloss = {g["id"]: g for g in v3["glossary"]}
    for s in v2["sections"]:
        for b in s["blocks"]:
            if b["id"] in gloss:
                g = gloss[b["id"]]
                assert f"**{g['term']}.** {g['definition']}" == b["text"]
            elif b["kind"] == "source_table":
                out = texts[b["id"]]
                assert out["kind"] == "prose" and out["filing_table"]["rows"] == b["rows"]
                for part in (b["before"]["text"], b["after"]["text"]):
                    assert part.strip() in out["text"]
                for row in b["rows"]:
                    for c in row:
                        assert c["text"] in out["text"]
            else:
                assert texts[b["id"]] == b  # every other block carried over unchanged


def test_facts_keep_meaning(v2, v3):
    stored = {f["id"]: f for f in v3["facts"]}
    for f in v2["facts"]:
        g = stored[f["id"]]
        for k in ("label", "period", "kind", "source", "formula", "inputs", "scale", "calc", "name"):
            assert g.get(k) == f.get(k), (f["id"], k)
        assert g.get("basis") == f.get("basis")
        if f["unit"] == "percent":
            assert g["unit"] == "ratio" and Decimal(g["value"]) * 100 == Decimal(f["value"])
            assert g["shown"] == f["value"] + "%"
        else:
            assert (g["unit"], g["value"]) == (f["unit"], f["value"])
        assert g.get("tag_ref") == f["tag"] and "concept" not in g  # R14 tags are row refs, not XBRL names


def test_shown_is_printed_in_the_quote(v3):
    src = {s["id"]: norm(s["quote"]) for s in v3["sources"]}
    rep = [f for f in v3["facts"] if f["kind"] == "reported"]
    assert len(rep) == 98
    for f in rep:
        assert f["shown"] in src[f["source"]], f["id"]
        assert isinstance(f["decimals"], int)
    assert not any("decimals" in f or "shown" in f for f in v3["facts"] if f["kind"] == "calculated")


def test_client_view_strips_server_fields(v3):
    before = copy.deepcopy(v3)
    c = client_view(v3)
    assert v3 == before  # client_view does not mutate the stored document
    assert not any(k in f for f in c["facts"] for k in ("calc", "name", "tag_ref"))
    assert any(f.get("calc") for f in v3["facts"])  # still stored server-side
    blob = json.dumps(c)
    assert "sha256" not in blob and "cleaned_start" not in blob and "coordinate_system" not in blob
    assert sum(1 for f in c["facts"] if "basis" in f) == 3  # basis survives, minus its hash


def test_no_invented_strings(v2, v3, chapters):
    """Every string the client receives is the pipeline's, the app's fixed chapter map, or structural."""
    c = client_view(v3)
    allowed = set(leaves(v2)) | {q for _i, _t, q in chapters} | set(SECTION_IDS.values()) | {
        "3", "shared", "ratio", "prose", ""}
    v2blocks = {b["id"]: b for s in v2["sections"] for b in s["blocks"]}
    for g in v3["glossary"]:  # split at the bold term of one v2 block (round trip tested above)
        if f"**{g['term']}.** {g['definition']}" == v2blocks[g["id"]]["text"]:
            allowed |= {g["term"], g["definition"]}
    src = {s["id"]: norm(s["quote"]) for s in v2["sources"]}
    pct = {f["id"] for f in v2["facts"] if f["unit"] == "percent"}
    for f in v3["facts"]:
        if f["kind"] == "reported" and f["shown"] in src[f["source"]]:
            allowed.add(f["shown"])  # the printed form, as it appears in the fact's own quote
        if f["id"] in pct:
            allowed.add(f["value"])  # the same percent restated as a ratio
    for b in v2blocks.values():
        if b["kind"] == "source_table":
            lines = {b["before"]["text"].strip(), b["after"]["text"].strip()}
            lines |= {" ".join(c["text"] for c in r if c["text"].strip()) for r in b["rows"]}
            out = next(x for s in v3["sections"] for x in s["blocks"] if x["id"] == b["id"])
            if set(out["text"].split("\n")) <= lines:
                allowed.add(out["text"])
    srcs = {s["id"]: s for s in v2["sources"]}  # a block text with {quote:src-id} set as that source's own quote
    allowed |= {quotes(b["text"], srcs) for b in v2blocks.values() if "{quote:" in (b.get("text") or "")}
    assert sorted(set(leaves(c)) - allowed) == []


@pytest.mark.parametrize("bad", ["version", "field", "section"])
def test_refuses_what_it_cannot_carry(v2, chapters, bad):
    doc = copy.deepcopy(v2)
    if bad == "version":
        doc["version"] = 3
    elif bad == "field":
        doc["assumptions"] = []
    else:
        doc["sections"][3]["id"] = "unknown-chapter"
    with pytest.raises(AdapterError):
        adapt_v2_to_v3(doc, {**META, "chapters": chapters})
