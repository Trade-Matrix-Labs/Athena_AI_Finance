"""API, overlays and the Desk page, on a store holding the ingested R14 edition."""
import copy
import json
import re
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from athena_app import store
from athena_app.server import create_app
from conftest import APP, CHECKER, FILING, FIXTURE, UI, ingest_r14
from test_ingest import business_prose, copy_delivery, edit_json

TOKEN = re.compile(r"\{fact:([^}]+)\}")
MARKER = re.compile(r"\[(src-\d+)\]")
LOCAL = "http://127.0.0.1"
JSON = {"content-type": "application/json"}


@pytest.fixture
def client(db_path, seeded):
    with TestClient(create_app(db_path, UI), base_url=LOCAL, headers=JSON) as c:
        yield c


def strings(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def unresolved(doc):
    """Fact tokens, fact references and source markers in the page data that do not resolve."""
    facts, sources = {f["id"] for f in doc["facts"]}, {s["id"] for s in doc["sources"]}
    refs = [t for s in strings(doc) for t in TOKEN.findall(s)]
    blocks = list(doc["cover"].get("blocks", [])) + [b for s in doc["sections"] + doc.get("appendix", [])
                                                      for b in s["blocks"]]
    refs += [c for b in blocks if b["kind"] == "table" for r in b["rows"] for c in r["cells"] if c]
    refs += [it[k] for it in doc["cover"]["kpis"]["items"] for k in ("fact", "delta", "compare") if it.get(k)]
    refs += [i for d in doc["digest"] for i in d["facts"]] + [i for g in doc["glossary"] for i in g["facts"]]
    refs += [i for f in doc["facts"] if f["kind"] == "calculated" for i in f["inputs"]]
    bad = sorted({r for r in refs if r not in facts})
    bad += sorted({m for s in strings(doc) for m in MARKER.findall(s) if m not in sources})
    bad += sorted({f["source"] for f in doc["facts"] if f["kind"] == "reported" and f["source"] not in sources})
    return bad, len(refs)


def data_slot(html, slot="report-data"):
    m = re.search(rf'<script type="application/json" id="{slot}">(.*?)</script>', html, re.S)
    assert m, f"{slot} slot missing"
    return m.group(1)


def page_data(html):
    return json.loads(data_slot(html))


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True, "editions": 1}


def test_list_reports(client):
    (ed,) = client.get("/api/reports").json()
    assert ed["filing"]["ticker"] == "PLTR" and ed["filing"]["accession"] == "0001321655-26-000011"
    assert ed["status"] == {"delivery_complete": True, "native_status": "HOLD",
                            "quality_disposition": "review_required", "publication_disposition": "draft"}


def test_get_report(client, seeded):
    r = client.get(f"/api/reports/{seeded}").json()
    assert r["edition"]["status"]["quality_disposition"] == "review_required"
    rf = r["edition"]["review_findings"]
    assert rf["count"] == len(rf["items"]) == 23 and {"class", "message", "status"} <= set(rf["items"][0])
    detail = r["edition"]["status_detail"]
    assert detail["native_final_verified"] is False and detail["final_store_reopen_verified"] is False
    assert "not native FINAL" in detail["delivery_complete_scope"]
    doc = r["document"]
    assert doc["version"] == "3" and len(doc["facts"]) == 125 and len(doc["sections"]) == 13
    assert not any(k in f for f in doc["facts"] for k in ("calc", "name", "tag_ref"))
    assert doc["edition"]["created"] == r["edition"]["created_at"]  # from the edition row, not the hashed document
    assert client.get("/api/reports/999").status_code == 404
    for bad in ("0", "abc", str(2**63), "99999999999999999999"):  # 422, never a 500
        assert client.get(f"/api/reports/{bad}").status_code == 422
        assert client.get(f"/reports/{bad}").status_code == 404  # a page address: an HTML not-found page


def test_overlay_crud(client, db_path, seeded):
    conn = store.connect(db_path)
    sha = store.get_edition(conn, seeded)["doc_sha256"]
    doc_before = store.get_document(conn, sha)
    conn.close()
    base = f"/api/editions/{seeded}/overlays"
    anchor = {"section_id": "cash-flow", "block_id": "cash-bridge", "exact": "operating cash"}
    r = client.post(base, json={"kind": "memo", "anchor": anchor, "body": {"text": "Check the bridge"}})
    assert r.status_code == 201
    memo = r.json()
    assert memo["kind"] == "memo" and memo["user_id"].startswith("r-") and memo["anchor"] == anchor
    reply = client.post(base, json={"kind": "thread", "anchor": anchor, "body": {"text": "Why?"},
                                    "parent_id": memo["id"]}).json()
    assert [o["id"] for o in client.get(base).json()] == [memo["id"], reply["id"]]
    assert [o["id"] for o in client.get(base, params={"kind": "thread"}).json()] == [reply["id"]]
    r = client.patch(f"{base}/{memo['id']}", json={"body": {"text": "Check the working-capital line"}})
    assert r.status_code == 200 and r.json()["body"]["text"].endswith("line") and r.json()["updated_at"]
    assert r.json()["anchor"] == anchor
    assert client.delete(f"{base}/{memo['id']}").status_code == 409  # has a reply
    assert client.delete(f"{base}/{reply['id']}").status_code == 204
    assert client.delete(f"{base}/{memo['id']}").status_code == 204
    assert client.get(base).json() == []
    assert client.delete(f"{base}/{memo['id']}").status_code == 404
    assert client.patch(f"{base}/12345", json={"body": {}}).status_code == 404
    assert client.post(base, json={"kind": "note", "body": {}}).status_code == 422
    assert client.post(base, json={"kind": "memo", "body": {}, "parent_id": 999}).status_code == 422
    assert client.get("/api/editions/999/overlays").status_code == 404
    conn = store.connect(db_path)
    assert store.get_document(conn, sha) == doc_before  # overlays never change the edition
    conn.close()


@pytest.mark.parametrize("path", ["/", "/reports/1"])
def test_desk_page_smoke(client, path):
    r = client.get(path)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    html = r.text
    assert "/*APP_JS*/" not in html and "/*APP_CSS*/" not in html and 'url("/fonts/manrope.ttf")' in html
    doc = page_data(html)
    bad, n = unresolved(doc)
    assert bad == [] and n == 283
    # counts for R14: 153 fact tokens and 162 source markers, all carried over
    assert sum(len(TOKEN.findall(s)) for s in strings(doc)) == 153
    assert sum(len(MARKER.findall(s)) for s in strings(doc)) == 162
    assert doc["edition"]["number"] == 1 and "calc" not in json.dumps(doc["facts"][0])
    strip = re.search(r'<div id="edition-status"[^>]*>(.*?)</div>', html).group(1)
    assert "Draft" in strip and "review required" in strip and "Not an accepted report" in strip
    assert "23 open review findings" in strip and "Delivery complete" in strip
    assert client.get("/fonts/manrope.ttf").status_code == 200


def test_smoke_check_catches_a_broken_token(client):
    """Break one fact token in the served data; the smoke check must report it."""
    doc = page_data(client.get("/").text)
    bad = copy.deepcopy(doc)
    blk = next(b for s in bad["sections"] for b in s["blocks"] if "{fact:" in b.get("text", ""))
    blk["text"] = blk["text"].replace("{fact:", "{fact:x-", 1)
    assert unresolved(doc)[0] == [] and len(unresolved(bad)[0]) == 1


def test_index_without_editions(db_path):
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        assert c.get("/").status_code == 404
        assert c.get("/api/reports").json() == []


PAYLOADS = ["</script><script>window.PWNED=1</script>", "<!--<script>", "<!--", "</SCRIPT >"]


def test_page_data_cannot_leave_its_script(db_path, tmp_path):
    """Report strings that would end or re-open the data script ("</script", "<!--<script>") stay data.
    Not one "<" is left inside the script element, and the slot parses back to the API document."""
    def add(d):
        b = business_prose(d)
        b["text"] += " " + " ".join(PAYLOADS)
    eid, _ = ingest_r14(db_path, copy_delivery(tmp_path, edit_json(add)))
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        html = c.get(f"/reports/{eid}").text
        api = c.get(f"/api/reports/{eid}").json()["document"]
    slot = data_slot(html)
    assert "<" not in slot and html.count('id="report-data"') == 1
    assert json.loads(slot) == api
    assert all(p in json.dumps(api, ensure_ascii=False) for p in PAYLOADS)


def overlay(depth):
    body = {}
    for _ in range(depth - 1):
        body = {"a": body}
    return {"kind": "memo", "body": body}


def test_write_requests_are_limited(client, seeded):
    """The write checks: JSON only, 64 KB, 8 levels, local Host names only."""
    base = f"/api/editions/{seeded}/overlays"
    assert client.post(base, json=overlay(7)).status_code == 201  # 8 levels with the request object
    assert client.post(base, json=overlay(8)).status_code == 422
    deep = b'{"kind":"memo","body":{"a":' + b"[" * 20000 + b"]" * 20000 + b"}}"
    assert len(deep) < 64 * 1024 and client.post(base, content=deep).status_code == 422  # refused before parsing
    assert client.post(base, json={"kind": "memo", "body": {"text": "x" * 70000}}).status_code == 413
    plain = {"content-type": "text/plain"}
    assert client.post(base, content=json.dumps(overlay(1)), headers=plain).status_code == 415
    with TestClient(client.app, base_url=LOCAL) as bare:  # no default Content-Type
        assert bare.post(base, data={"kind": "memo"}).status_code == 415  # a form post
        chunked = bare.post(base, content=iter([json.dumps(overlay(1)).encode()]), headers=JSON)
        assert chunked.status_code == 411  # no Content-Length: the 64 KB cap could not hold
    assert client.patch(f"{base}/abc", json={"body": {}}).status_code == 422
    assert client.patch(f"{base}/{2**63}", json={"body": {}}).status_code == 422
    with TestClient(client.app, base_url="http://attacker.example", headers=JSON) as other:
        assert other.get("/api/health").status_code == 400
        assert other.post(base, json=overlay(1)).status_code == 400
    with TestClient(client.app, base_url="http://localhost:8000") as named:
        assert named.get("/api/health").status_code == 200


def test_delete_takes_no_body(client, seeded):
    """A plain DELETE needs no headers; a DELETE with any body is refused without reading it."""
    base = f"/api/editions/{seeded}/overlays"
    ids = [client.post(base, json=overlay(1)).json()["id"] for _ in range(3)]
    with TestClient(client.app, base_url=LOCAL, cookies=client.cookies) as bare:  # the same reader
        assert bare.delete(f"{base}/{ids[0]}").status_code == 204  # like fetch(url, {method: "DELETE"})
        assert bare.request("DELETE", f"{base}/{ids[1]}", content=b"{}", headers=JSON).status_code == 413
        sent = []

        def twenty_mb():
            for _ in range(20):
                sent.append(1)
                yield b"x" * 2**20
        t = time.monotonic()
        assert bare.request("DELETE", f"{base}/{ids[1]}", content=twenty_mb()).status_code == 413
        assert time.monotonic() - t < 1 and len(sent) < 20  # refused before the body was read
        assert bare.delete(f"{base}/{ids[1]}", headers=JSON).status_code == 204  # a Content-Type alone is fine
    assert [o["id"] for o in client.get(base).json()] == [ids[2]]


def test_no_cors(client, seeded):
    """The CORS position is unchanged: no CORS headers, so a cross-site page cannot read or preflight a write."""
    origin = {"origin": "http://attacker.example"}
    responses = [client.get("/api/reports", headers=origin),
                 client.delete(f"/api/editions/{seeded}/overlays/1", headers=origin),
                 client.options(f"/api/editions/{seeded}/overlays/1",
                                headers=origin | {"access-control-request-method": "DELETE"})]
    assert responses[2].status_code == 405
    assert not [k for r in responses for k in r.headers if k.lower().startswith("access-control-")]


@pytest.mark.parametrize("path", ["/", "/reports/1"])
def test_app_config_slot(client, seeded, path):
    """The frontend contract for app mode: a second JSON slot next to report-data, escaped the same way."""
    html = client.get(path).text
    slot = data_slot(html, "app-config")
    assert "<" not in slot and html.count('id="app-config"') == 1
    assert json.loads(slot) == {"api_base": "/api", "edition_id": seeded, "reports_url": "/api/reports",
                                "overlays_url": f"/api/editions/{seeded}/overlays"}
    assert html.index('id="report-data"') < html.index('id="app-config"')
    assert client.get(json.loads(slot)["overlays_url"]).status_code == 200


def test_status_strip_can_be_turned_off(db_path, seeded):
    with TestClient(create_app(db_path, UI, status_strip=False), base_url=LOCAL) as c:
        html = c.get("/").text
    assert 'id="edition-status"' not in html and page_data(html)["edition"]["number"] == 1


def test_migrations_race_safe_in_one_process(tmp_path):
    """Eight connections opening one fresh store at once all succeed and leave one schema."""
    for k in range(3):
        db, errors = tmp_path / f"race{k}.db", []

        def open_store():
            try:
                store.connect(db).close()
            except Exception as e:  # collected, asserted below
                errors.append(f"{type(e).__name__}: {e}")
        threads = [threading.Thread(target=open_store) for _ in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert errors == []
        conn = store.connect(db, migrate=False)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == len(list(store.MIGRATIONS.glob("*.sql")))
        conn.close()


RACER = """import sys, time
t0, db, what = float(sys.argv[1]), sys.argv[2], sys.argv[3]
if what == "server":
    from athena_app.server import create_app
else:
    from athena_app.ingest import main
time.sleep(max(0, t0 - time.time()))
if what == "server":
    create_app(db, sys.argv[4])
else:
    sys.exit(main(sys.argv[4:]))
"""


def test_server_start_races_an_ingest_process(tmp_path):
    """A server starting while a separate ingest process opens the same fresh store; both run their
    migrations at the same instant (a shared start time), and both succeed."""
    for k in range(2):
        db = tmp_path / f"race{k}.db"
        t0 = str(time.time() + 1.5)
        ingest = [str(FIXTURE), "--db", str(db), "--ui", str(UI), "--checker", str(CHECKER), "--filing", str(FILING)]
        procs = [subprocess.Popen([sys.executable, "-B", "-c", RACER, t0, str(db), "server", str(UI)], cwd=APP,
                                  stderr=subprocess.PIPE, text=True) for _ in range(3)]
        procs.append(subprocess.Popen([sys.executable, "-B", "-c", RACER, t0, str(db), "ingest", *ingest], cwd=APP,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
        results = [(p.wait(timeout=60), p.stderr.read()) for p in procs]
        assert [rc for rc, _ in results] == [0, 0, 0, 0], results
        with TestClient(create_app(db, UI), base_url=LOCAL) as c:
            assert c.get("/api/health").json() == {"ok": True, "editions": 1}
