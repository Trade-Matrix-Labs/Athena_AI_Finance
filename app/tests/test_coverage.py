"""Partial editions: the delivery manifest's `coverage` (produced / failed / planned chapter ids) is checked at ingest,
kept with the edition, and handed to the Desk with the canonical chapter map; the stored report stays sparse.
fixtures/s1/ is a synthetic one-chapter fake (Profitability only), not model output and not a report: the backend's
immutable bytes, whose delivery_complete true covers stage S1 only ("S1: 1 of 13 chapters")."""
import json
import re
import shutil

import pytest
from fastapi.testclient import TestClient

from athena_app import ingest as ing
from athena_app import store
from athena_app.server import create_app
from conftest import APP, UI, ingest_r14
from test_api import LOCAL, data_slot
from test_ingest import EMPTY, counts, edition

S1 = APP / "fixtures" / "s1"


def manifest(d=S1):
    return json.loads((d / "DELIVERY-MANIFEST.json").read_text())


def s1_copy(tmp_path, coverage=None, drop=False, scope=None):
    d = tmp_path / "s1"
    shutil.copytree(S1, d)
    if scope is not None:
        side = json.loads((d / ing.SIDECAR).read_text()) | {"delivery_complete_scope": scope}
        (d / ing.SIDECAR).write_text(json.dumps(side))
    if coverage is not None or drop:
        m = manifest(d)
        if drop:
            del m["coverage"]
        else:
            m["coverage"] = coverage
        (d / "DELIVERY-MANIFEST.json").write_text(json.dumps(m))
    return d


@pytest.fixture(scope="module")
def ids():
    return [c[0] for c in ing.chapters(UI)]


def test_s1_fixture_shape(ids):
    """The structure the tests rely on (not the fixture's exact bytes, which the backend may still change)."""
    cov = manifest()["coverage"]
    assert set(cov) == {"produced", "failed", "planned"} and len(ids) == 13
    assert cov["produced"] == ["profitability"] and cov["failed"] == []
    assert sorted(cov["planned"]) == sorted(i for i in ids if i != "profitability")
    side = json.loads((S1 / ing.SIDECAR).read_text())
    # stage-scoped: true means every chapter requested for the stage arrived, not that the report is complete
    assert side["delivery_complete"] is True and re.fullmatch(r"\S+: 1 of 13 chapters", side["delivery_complete_scope"])


def test_s1_ingests_sparse_with_coverage(db_path):
    eid, state = ingest_r14(db_path, S1)
    ed = edition(db_path, eid)
    assert state == "created" and ed["producer"]["coverage"] == manifest()["coverage"]
    side = json.loads((S1 / ing.SIDECAR).read_text())
    assert ed["status"] == {k: side[k] for k in store.STATUS}  # exactly as in the sidecar
    conn = store.connect(db_path)
    try:
        doc = store.get_document(conn, ed["doc_sha256"])
    finally:
        conn.close()
    # the stored report keeps only what was delivered, numbered as before (no placeholder sections)
    assert [(s["id"], s["number"]) for s in doc["sections"]] == [("profitability", 1)]
    assert [d["section"] for d in doc["digest"]] == ["profitability"]


def test_coverage_reaches_the_desk(db_path):
    eid, _ = ingest_r14(db_path, S1)
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        api = c.get(f"/api/reports/{eid}").json()
        cfg = json.loads(data_slot(c.get(f"/reports/{eid}").text, "app-config"))
    assert api["edition"]["producer"]["coverage"] == manifest()["coverage"]
    assert [s["id"] for s in api["document"]["sections"]] == ["profitability"]
    assert cfg["coverage"] == manifest()["coverage"]
    assert cfg["chapters"] == [list(c) for c in ing.chapters(UI)]
    assert cfg["chapters"][2][:2] == ["profitability", "Profitability"]  # Profitability is chapter 03 of 13


def test_edition_without_coverage_unchanged(db_path, tmp_path):
    r14, _ = ingest_r14(db_path)
    plain, _ = ingest_r14(db_path, s1_copy(tmp_path, drop=True))
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        for eid in (r14, plain):
            assert "coverage" not in edition(db_path, eid)["producer"]
            cfg = json.loads(data_slot(c.get(f"/reports/{eid}").text, "app-config"))
            assert cfg == {"api_base": "/api", "edition_id": eid, "reports_url": "/api/reports",
                           "overlays_url": f"/api/editions/{eid}/overlays"}


def test_stage_complete_partial_edition_does_not_read_full(db_path, capsys):
    """delivery_complete true for stage S1 with 1 of 13 chapters produced. Every place the App states
    completeness says partial, 1 of 13; the status fields stay exactly as the sidecar has them."""
    from conftest import CHECKER, FILING
    assert ing.main([str(S1), "--db", str(db_path), "--ui", str(UI), "--checker", str(CHECKER), "--filing", str(FILING)]) == 0
    out = capsys.readouterr().out
    assert '"delivery_complete": true' in out and "coverage 1 of 13 chapters produced, 0 failed, 12 planned" in out
    side = json.loads((S1 / ing.SIDECAR).read_text())
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        page = c.get("/reports/1").text
        api = c.get("/api/reports/1").json()["edition"]
    strip = re.search(r'<div id="edition-status"[^>]*>(.*?)</div>', page).group(1)
    assert "Delivery partial: 1 of 13 chapters" in strip and "Not an accepted report" in strip
    assert "Delivery complete" not in strip and "HOLD" in strip and "review required" in strip and "Draft" in strip
    assert api["status"] == {k: side[k] for k in store.STATUS} == {
        "delivery_complete": True, "native_status": "HOLD", "quality_disposition": "review_required",
        "publication_disposition": "draft"}
    assert len(api["producer"]["coverage"]["produced"]) == 1 and api["status_detail"]["delivery_complete_scope"] == side["delivery_complete_scope"]
    assert json.loads(data_slot(page, "app-config"))["coverage"] == api["producer"]["coverage"]


@pytest.mark.parametrize("scope", ["S1: 2 of 13 chapters", "S1: 1 of 12 chapters", "S2: 13 of 13 chapters"])
def test_scope_that_disagrees_with_coverage_refuses(db_path, tmp_path, scope):
    with pytest.raises(ing.IngestError, match="disagrees with manifest coverage"):
        ingest_r14(db_path, s1_copy(tmp_path, scope=scope))
    assert counts(db_path) == EMPTY


def test_scope_of_another_stage_that_agrees_is_kept(db_path, tmp_path):
    eid, _ = ingest_r14(db_path, s1_copy(tmp_path, scope="S2: 1 of 13 chapters"))
    assert edition(db_path, eid)["status_detail"]["delivery_complete_scope"] == "S2: 1 of 13 chapters"


def planned_without(ids, *drop):
    return [i for i in ids if i != "profitability" and i not in drop]


REFUSALS = {
    "not an object": lambda ids: ["profitability"],
    "a key missing": lambda ids: {"produced": ["profitability"], "planned": planned_without(ids)},
    "an extra key": lambda ids: {"produced": ["profitability"], "failed": [], "planned": planned_without(ids), "skipped": []},
    "a list that is not a list": lambda ids: {"produced": "profitability", "failed": [], "planned": planned_without(ids)},
    "an id that is not a string": lambda ids: {"produced": ["profitability"], "failed": [3], "planned": planned_without(ids)},
    "a chapter missing": lambda ids: {"produced": ["profitability"], "failed": [], "planned": planned_without(ids, "watchlist")},
    "an unknown chapter": lambda ids: {"produced": ["profitability"], "failed": ["outlook"], "planned": planned_without(ids)},
    "a chapter twice": lambda ids: {"produced": ["profitability"], "failed": ["business"], "planned": planned_without(ids)},
    "produced is not what was delivered": lambda ids: {"produced": ["business"], "failed": [],
                                                       "planned": ["profitability", *planned_without(ids, "business")]},
    "a delivered chapter listed as failed": lambda ids: {"produced": [], "failed": ["profitability"], "planned": planned_without(ids)},
}


@pytest.mark.parametrize("case", sorted(REFUSALS))
def test_bad_coverage_refuses_and_stores_nothing(db_path, tmp_path, ids, case):
    d = s1_copy(tmp_path, REFUSALS[case](ids))
    with pytest.raises(ing.IngestError, match="coverage"):
        ingest_r14(db_path, d)
    assert counts(db_path) == EMPTY


def test_cli_refuses_bad_coverage(db_path, tmp_path, ids, capsys):
    from conftest import CHECKER, FILING
    d = s1_copy(tmp_path, REFUSALS["a chapter missing"](ids))
    rc = ing.main([str(d), "--db", str(db_path), "--ui", str(UI), "--checker", str(CHECKER), "--filing", str(FILING)])
    assert rc == 1 and "REFUSED" in capsys.readouterr().err and counts(db_path) == EMPTY


def test_same_report_same_coverage_reingests_unchanged(db_path, tmp_path, ids):
    eid, _ = ingest_r14(db_path, S1)
    cov = manifest()["coverage"]
    shuffled = {k: list(reversed(cov[k])) for k in cov}  # the same coverage, listed in another order
    assert ingest_r14(db_path, s1_copy(tmp_path, shuffled)) == (eid, "unchanged")
    assert edition(db_path, eid)["producer"]["coverage"] == cov


def reingest_refuses(db_path, first, second, match):
    eid, _ = ingest_r14(db_path, first)
    before = edition(db_path, eid)
    with pytest.raises(ing.IngestError, match=match):
        ingest_r14(db_path, second)
    assert edition(db_path, eid) == before and counts(db_path)["editions"] == 1


def test_reingest_with_other_coverage_refuses(db_path, tmp_path, ids):
    """Valid on its own (fresh store refuses it only because REPORT.json carries profitability), and must not pass
    as "unchanged" when the same REPORT.json is already stored."""
    reingest_refuses(db_path, S1, s1_copy(tmp_path, REFUSALS["produced is not what was delivered"](ids)), "coverage")


def test_reingest_adding_coverage_refuses(db_path, tmp_path):
    reingest_refuses(db_path, s1_copy(tmp_path / "a", drop=True), S1, "coverage")


def test_reingest_dropping_coverage_refuses(db_path, tmp_path):
    reingest_refuses(db_path, S1, s1_copy(tmp_path, drop=True), "coverage")


def test_reingest_with_other_scope_refuses(db_path, tmp_path):
    reingest_refuses(db_path, S1, s1_copy(tmp_path, scope="S2: 1 of 13 chapters"), "delivery_complete_scope")
