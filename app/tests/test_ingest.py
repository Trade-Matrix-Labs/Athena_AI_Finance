"""Ingest: hash check, integrity refusal, review findings, status sidecar, all-or-nothing storage, idempotency."""
import collections
import json
import shutil
import sqlite3

import pytest

from athena_app import ingest as ing
from athena_app import store
from athena_app.validate import classify
from conftest import CHECKER, FILING, FIXTURE, UI, ingest_r14

# what the checker finds in R14 today (review findings); any change here is news
R14_FINDINGS = {"quote length": 12, "period naming": 1, "sign wording": 2, "unit wording": 2,
                "key point": 6}
R14_STATUS = {"delivery_complete": True, "native_status": "HOLD",
              "quality_disposition": "review_required", "publication_disposition": "draft"}
EMPTY = {"filings": 0, "documents": 0, "editions": 0, "overlays": 0}


def counts(db_path):
    conn = store.connect(db_path)
    try:
        return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for t in ("filings", "documents", "editions", "overlays")}
    finally:
        conn.close()


def edition(db_path, eid):
    conn = store.connect(db_path)
    try:
        return store.get_edition(conn, eid)
    finally:
        conn.close()


def copy_delivery(tmp_path, edit=None, sidecar=True):
    d = tmp_path / "delivery"
    shutil.copytree(FIXTURE, d)
    if not sidecar:
        (d / ing.SIDECAR).unlink()
    if edit:
        raw = (d / "REPORT.json").read_text()
        (d / "REPORT.json").write_text(edit(raw))
        sha = store.sha256((d / "REPORT.json").read_bytes())
        for name in ("DELIVERY-MANIFEST.json", ing.SIDECAR):
            if (d / name).exists():
                m = json.loads((d / name).read_text())
                m["report_sha256"] = sha
                (d / name).write_text(json.dumps(m))
    return d


def test_r14_ingests_with_review_findings(db_path):
    eid, state = ingest_r14(db_path)
    ed = edition(db_path, eid)
    assert state == "created" and ed["status"] == R14_STATUS
    rf = ed["review_findings"]
    assert rf["count"] == sum(R14_FINDINGS.values()) == 23
    assert collections.Counter(f["class"] for f in rf["items"]) == R14_FINDINGS
    assert all(f["status"] == "open" for f in rf["items"])
    assert ed["status_detail"]["delivery_complete_scope"].startswith("The retained reader package contains a cover")
    assert ed["status_detail"]["native_final_verified"] is False
    assert ed["status_detail"]["final_store_reopen_verified"] is False
    assert ed["status_detail"]["source"].startswith("sidecar da1b24f80412")


def test_without_sidecar_defaults_are_conservative(db_path, tmp_path):
    eid, _ = ingest_r14(db_path, copy_delivery(tmp_path, sidecar=False))
    assert edition(db_path, eid)["status"] == {"delivery_complete": False, "native_status": "HOLD",
                                               "quality_disposition": "unreviewed", "publication_disposition": "draft"}


def test_hash_mismatch_is_refused(db_path, tmp_path):
    d = copy_delivery(tmp_path)
    m = json.loads((d / "DELIVERY-MANIFEST.json").read_text())
    m["report_sha256"] = "0" * 64
    (d / "DELIVERY-MANIFEST.json").write_text(json.dumps(m))
    with pytest.raises(ing.IngestError, match="sha256"):
        ingest_r14(db_path, d)
    assert counts(db_path) == EMPTY


@pytest.mark.parametrize("change, match", [({"report_sha256": "0" * 64}, "status sidecar is for report"),
                                           ({"schema": "athena-edition-status.v0"}, "schema")])
def test_bad_sidecar_is_refused(db_path, tmp_path, change, match):
    d = copy_delivery(tmp_path)
    side = json.loads((d / ing.SIDECAR).read_text()) | change
    (d / ing.SIDECAR).write_text(json.dumps(side))
    with pytest.raises(ing.IngestError, match=match):
        ingest_r14(db_path, d)
    assert counts(db_path) == EMPTY


def test_broken_fact_token_is_refused(db_path, tmp_path):
    """One unresolved fact token is an integrity error; nothing is stored."""
    d = copy_delivery(tmp_path, lambda t: t.replace("{fact:revenue-fy2025}", "{fact:revenue-fy2o25}", 1))
    with pytest.raises(ing.ValidationRefused) as e:
        ingest_r14(db_path, d)
    assert e.value.errors == ["section ~cover/summary-thesis: unknown fact revenue-fy2o25"]
    assert counts(db_path) == EMPTY


@pytest.mark.parametrize("flags", [{"quality": "accepted"}, {"publication": "published"},
                                   {"quality": "unreviewed"}])
def test_flags_cannot_loosen_the_sidecar(db_path, flags):
    with pytest.raises(ing.IngestError, match="only make it stricter"):
        ingest_r14(db_path, **flags)
    assert counts(db_path) == EMPTY


def test_flag_can_make_it_stricter(db_path):
    eid, _ = ingest_r14(db_path, quality="failed")
    assert edition(db_path, eid)["status"]["quality_disposition"] == "failed"


@pytest.mark.parametrize("field, value", [("quality_disposition", "accepted"),
                                          ("publication_disposition", "published")])
def test_open_findings_block_accepted_and_published(db_path, tmp_path, field, value):
    d = copy_delivery(tmp_path)
    side = json.loads((d / ing.SIDECAR).read_text()) | {field: value}
    (d / ing.SIDECAR).write_text(json.dumps(side))
    with pytest.raises(ing.IngestError, match="open review finding"):
        ingest_r14(db_path, d)
    assert counts(db_path) == EMPTY


@pytest.mark.parametrize("sql", ["UPDATE editions SET quality_disposition = 'accepted'",
                                 "UPDATE editions SET publication_disposition = 'published'"])
def test_store_guard_blocks_later_status_changes(db_path, seeded, sql):
    conn = store.connect(db_path)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="open review findings|only become stricter"):
            conn.execute(sql)
        conn.execute("UPDATE editions SET quality_disposition = 'failed'")  # stricter is fine
    finally:
        conn.close()


def test_reingest_is_idempotent(db_path, seeded):
    before = counts(db_path)
    assert ingest_r14(db_path) == (seeded, "unchanged")  # known by its sha256: no adapt, no validate, no write
    assert counts(db_path) == before


def with_sidecar(tmp_path, **change):
    d = copy_delivery(tmp_path)
    side = json.loads((d / ing.SIDECAR).read_text()) | change
    (d / ing.SIDECAR).write_text(json.dumps(side))
    return d


def test_reingest_only_tightens(db_path, seeded, tmp_path):
    """A stricter sidecar or flag tightens the stored status; a looser sidecar is ignored, a looser flag refused."""
    notes = []
    d = with_sidecar(tmp_path, quality_disposition="failed", publication_disposition="withdrawn", native_status="FINAL")
    assert ingest_r14(db_path, d, notes=notes) == (seeded, "tightened")
    assert edition(db_path, seeded)["status"] == R14_STATUS | {"quality_disposition": "failed",
                                                               "publication_disposition": "withdrawn"}
    assert "tightened: quality_disposition review_required -> failed" in notes
    assert any(n.startswith("ignored: native_status 'FINAL'") for n in notes)
    notes.clear()
    assert ingest_r14(db_path, notes=notes) == (seeded, "unchanged")  # the original, looser sidecar
    assert "ignored: quality_disposition review_required would loosen the stored failed" in notes
    with pytest.raises(ing.IngestError, match="would loosen the stored withdrawn"):
        ingest_r14(db_path, publication="draft")
    assert edition(db_path, seeded)["status"]["publication_disposition"] == "withdrawn"
    assert counts(db_path)["editions"] == 1


def test_doc_id_does_not_depend_on_ingest_time(tmp_path, monkeypatch):
    """Two fresh stores, two forced ingest times, one document id; the time lives on the edition row."""
    got = []
    for n, t in enumerate(("2026-01-01T00:00:00Z", "2027-06-15T12:34:56Z")):
        monkeypatch.setattr(store, "now", lambda t=t: t)
        db = tmp_path / f"t{n}.db"
        eid, _ = ingest_r14(db)
        conn = store.connect(db)
        ed = store.get_edition(conn, eid)
        assert "created" not in store.get_document(conn, ed["doc_sha256"])["edition"]
        conn.close()
        got.append((ed["doc_sha256"], ed["created_at"]))
    assert got[0][0] == got[1][0]
    assert [c for _, c in got] == ["2026-01-01T00:00:00Z", "2027-06-15T12:34:56Z"]


def edit_json(fn):
    def edit(raw):
        d = json.loads(raw)
        fn(d)
        return json.dumps(d, ensure_ascii=False)
    return edit


def first_table(d):
    return next(b for s in d["sections"] for b in s["blocks"] if b["kind"] == "source_table")


def set_cell(d):
    c = next(c for r in first_table(d)["rows"] for c in r if any(ch.isdigit() for ch in c["text"]))
    c["text"] = "999,999"


@pytest.mark.parametrize("edit", [
    lambda d: first_table(d)["before"].update(text="Invented lead-in sentence that is not in the filing."),
    lambda d: first_table(d)["after"].update(text="Invented closing note."),
    set_cell,
], ids=["lead-in", "closing", "cell"])
def test_filing_table_text_must_be_in_the_filing(db_path, tmp_path, edit):
    """The lead-in, every joined row and the closing text of a filing table are quotes of the filing."""
    with pytest.raises(ing.ValidationRefused) as e:
        ingest_r14(db_path, copy_delivery(tmp_path, edit_json(edit)))
    assert len(e.value.errors) == 1 and "filing table text not found in filing" in e.value.errors[0]
    assert counts(db_path) == EMPTY


def business_prose(d):
    return next(b for s in d["sections"] if s["id"] == "business" for b in s["blocks"] if b["kind"] == "prose")


def spoof(d):  # an unknown fact inside a block whose id reads like a review message
    b = business_prose(d)
    b["id"], b["text"] = "x: LINT unit words after y:", b["text"] + " {fact:does-not-exist}"


@pytest.mark.parametrize("edit, error", [
    (spoof, "block id 'x: LINT unit words after y:' is not a plain slug"),
    (lambda d: d["facts"][0].update(id="Revenue FY25"), "fact id 'Revenue FY25' is not a plain slug"),
    (lambda d: d["sources"][0].update(id="src 1"), "source id 'src 1' is not a plain slug"),
    (lambda d: business_prose(d).update(text=business_prose(d)["text"] + " {fact:x: y}"),
     "fact reference 'x: y' is not a plain slug"),
], ids=["block-spoof", "fact", "source", "reference"])
def test_ids_must_be_plain_slugs(db_path, tmp_path, edit, error):
    """Ids are checked before the checker runs, so none can make an integrity error read as a review finding."""
    with pytest.raises(ing.ValidationRefused) as e:
        ingest_r14(db_path, copy_delivery(tmp_path, edit_json(edit)))
    assert e.value.errors == [error]
    assert counts(db_path) == EMPTY


@pytest.mark.parametrize("sql, match", [
    ("UPDATE documents SET bytes = x'7b7d'", "documents are immutable"),
    ("DELETE FROM documents WHERE sha256 = 'spare'", "documents are immutable"),
    ("DELETE FROM editions", "cannot be deleted"),
    ("UPDATE editions SET doc_sha256 = source_sha256", "fields are immutable"),
    ("UPDATE editions SET validation_json = json_set(validation_json, '$.review_findings', json('[]'))", "fields are immutable"),
    ("UPDATE editions SET quality_disposition = 'accepted', publication_disposition = 'published',"
     " validation_json = json_set(validation_json, '$.review_findings', json('[]'))", "immutable|stricter|open review"),
    ("UPDATE editions SET validation_json = replace(validation_json, '\"open\"', '\"closed\"')", "fields are immutable"),
    ("UPDATE editions SET created_at = '2000-01-01T00:00:00Z'", "fields are immutable"),
    ("UPDATE editions SET quality_disposition = 'unreviewed'", "only become stricter"),
    ("UPDATE editions SET publication_disposition = 'published'", "only become stricter|open review findings"),
    ("INSERT INTO editions (accession, language, number, doc_sha256, source_sha256, native_status, quality_disposition,"
     " publication_disposition, producer_json, validation_json, created_at) SELECT accession, language, 99, doc_sha256,"
     " 'spare', native_status, 'accepted', 'published', producer_json, '{}', created_at FROM editions",
     "review_findings list"),
], ids=["doc-update", "doc-delete", "edition-delete", "swap-doc", "drop-findings", "accept-and-drop", "close-findings",
        "created", "looser", "publish", "insert-without-findings"])
def test_store_keeps_editions_immutable(db_path, seeded, sql, match):
    """The database itself refuses these writes, whatever program sends them."""
    conn = store.connect(db_path)
    try:
        conn.execute("INSERT INTO documents (sha256, bytes) VALUES ('spare', x'00')")
        before = conn.execute("SELECT * FROM editions").fetchall(), conn.execute("SELECT * FROM documents").fetchall()
        with pytest.raises(sqlite3.IntegrityError, match=match):
            conn.execute(sql)
        assert (conn.execute("SELECT * FROM editions").fetchall(), conn.execute("SELECT * FROM documents").fetchall()) == before
    finally:
        conn.close()


def test_store_refuses_accepted_with_open_findings(db_path, seeded):
    """The guard holds for a direct store write, not only for the ingest path."""
    conn = store.connect(db_path)
    ed = store.get_edition(conn, seeded)
    finding = {"class": "quote length", "message": "src-02: quote longer than 260 chars", "status": "open"}
    try:
        for status in ({"quality_disposition": "accepted", "publication_disposition": "draft"},
                       {"quality_disposition": "review_required", "publication_disposition": "published"}):
            with pytest.raises(sqlite3.IntegrityError, match="open review findings"):
                store.insert_edition(conn, filing=ed["filing"], language="en", number=2, source_bytes=b"other",
                                     doc_bytes=b"{}", status=ed["status"] | status, producer={},
                                     validation={"review_findings": [finding]})
        assert counts(db_path)["editions"] == 1
    finally:
        conn.close()


@pytest.fixture
def passing_checker(tmp_path):
    """A checker double that finds nothing (it reads the filing like the real one), to exercise accepted /
    published without findings."""
    p = tmp_path / "pass_checker.py"
    p.write_text("import importlib.util\n"
                 f"spec = importlib.util.spec_from_file_location('real_checker', {str(CHECKER)!r})\n"
                 "real = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(real)\n"
                 "load_filing, norm = real.load_filing, real.norm\n\n"
                 "def check(report, tags, text):\n    return {}, [], [], []\n")
    return p


def test_accepted_without_findings(db_path, tmp_path, passing_checker):
    d = copy_delivery(tmp_path)
    side = json.loads((d / ing.SIDECAR).read_text()) | {"quality_disposition": "accepted"}
    (d / ing.SIDECAR).write_text(json.dumps(side))
    conn = store.connect(db_path)
    eid, state = ing.ingest(conn, d, ui_dir=UI, checker=passing_checker, filing=FILING)
    conn.close()
    assert state == "created" and edition(db_path, eid)["status"]["quality_disposition"] == "accepted"
    assert counts(db_path) == {"filings": 1, "documents": 2, "editions": 1, "overlays": 0}


def test_stored_documents(db_path, seeded):
    conn = store.connect(db_path)
    ed = store.get_edition(conn, seeded)
    doc = store.get_document(conn, ed["doc_sha256"])
    src = conn.execute("SELECT bytes FROM documents WHERE sha256 = ?", (ed["source_sha256"],)).fetchone()[0]
    conn.close()
    assert src == (FIXTURE / "REPORT.json").read_bytes() and ed["source_sha256"] == store.sha256(src)
    assert doc["version"] == "3" and doc["edition"]["number"] == 1


def test_failure_mid_write_leaves_nothing(db_path, monkeypatch):
    real = store.insert_edition

    def insert_then_fail(*a, **kw):
        real(*a, **kw)
        raise RuntimeError("disk full")

    monkeypatch.setattr(store, "insert_edition", insert_then_fail)
    with pytest.raises(RuntimeError):
        ingest_r14(db_path)
    assert counts(db_path) == EMPTY


def test_classification():
    review = {"src-02: quote longer than 260 chars": "quote length",
              "x-fy2025: period '31 Dec 2025' should name both dates, '31 Dec 2024 to 31 Dec 2025'": "period naming",
              "section a/b: LINT negative value x in prose": "sign wording",
              "section a/b: LINT unit words after x: ' shares re'": "unit wording",
              "section a/b: LINT '$' before x": "unit wording"}
    assert {m: classify(m) for m in review} == review
    for blocking in ("src-01: quote not found in filing", "section a/b: unknown fact x", "section a/b: unknown source src-9",
                     "x: shown '1' not in src-1 quote", "x: value 1 != recomputed 2", "section a: missing question",
                     "section a/b: LINT doubled brackets around a source marker", "x: shown '1' drops unit words printed in s"):
        assert classify(blocking) is None
    # an integrity error dressed up through a free-form id or term: every part of a pattern is pinned
    for spoofed in ("section business/x: LINT unit words after y:: unknown fact does-not-exist",
                    "section a/b: LINT unit words after y: 'a': unknown fact q",
                    "section a/b: LINT unit words after y: 'a'\nsection c: unknown fact q",
                    "Src-01: quote longer than 260 chars",
                    "glossary Free cash flow: LINT '$' before x"):
        assert classify(spoofed) is None
    assert classify("glossary Free cash flow: LINT '$' before x", ["Free cash flow"]) == "unit wording"


def test_cli(db_path, capsys):
    args = [str(FIXTURE), "--db", str(db_path), "--ui", str(UI), "--checker", str(CHECKER), "--filing", str(FILING)]
    assert ing.main(args + ["--quality-disposition", "accepted"]) == 1 and "REFUSED" in capsys.readouterr().err
    assert counts(db_path) == EMPTY
    assert ing.main(args) == 0
    out = capsys.readouterr().out
    assert "stored edition 1" in out and "open review findings 23" in out
    assert ing.main(args + ["--publication-disposition", "withdrawn"]) == 0
    out = capsys.readouterr().out
    assert "status tightened on edition 1" in out and "tightened: publication_disposition draft -> withdrawn" in out
    assert ing.main(args) == 0
    assert "ignored: publication_disposition draft would loosen the stored withdrawn" in capsys.readouterr().out
    assert ing.main(args + ["--publication-disposition", "draft"]) == 1
    assert "would loosen the stored withdrawn" in capsys.readouterr().err


def test_cli_reports_database_errors(tmp_path, capsys):
    bad = tmp_path / "not-a-db"
    bad.write_bytes(b"not a database file " * 100)
    args = [str(FIXTURE), "--db", str(bad), "--ui", str(UI), "--checker", str(CHECKER), "--filing", str(FILING)]
    assert ing.main(args) == 1 and "REFUSED: database" in capsys.readouterr().err
