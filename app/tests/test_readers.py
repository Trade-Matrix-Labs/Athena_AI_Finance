"""Personal overlays per reader: a random reader id in an HttpOnly, SameSite=Lax cookie (Secure over
HTTPS), memos and threads scoped to it, and a per-reader cap. The browser's fetch calls are unchanged: same-origin
requests send the cookie."""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from athena_app import server
from athena_app.server import READER_COOKIE, create_app
from conftest import UI

LOCAL = "http://127.0.0.1"
JSON = {"content-type": "application/json"}
MEMO = {"kind": "memo", "body": {"text": "mine"}}


@pytest.fixture
def app(db_path, seeded):
    return create_app(db_path, UI)


def browser(app, base_url=LOCAL, **kw):
    return TestClient(app, base_url=base_url, headers=JSON, **kw)


def test_each_browser_sees_only_its_own_overlays(app, seeded, db_path):
    a, b = browser(app), browser(app)
    base = f"/api/editions/{seeded}/overlays"
    assert a.get("/").status_code == 200 and b.get(f"/reports/{seeded}").status_code == 200  # a page visit sets it
    ca, cb = a.cookies[READER_COOKIE], b.cookies[READER_COOKIE]
    assert ca != cb and len(ca) >= 22
    memo = a.post(base, json=MEMO).json()
    reply = a.post(base, json={"kind": "thread", "body": {"text": "why"}, "parent_id": memo["id"]}).json()
    assert [o["id"] for o in a.get(base).json()] == [memo["id"], reply["id"]]
    assert b.get(base).json() == [] and b.get(base, params={"kind": "thread"}).json() == []
    assert b.patch(f"{base}/{memo['id']}", json={"body": {"text": "theirs"}}).status_code == 404
    assert b.delete(f"{base}/{reply['id']}").status_code == 404
    assert b.post(base, json={"kind": "thread", "body": {}, "parent_id": memo["id"]}).status_code == 422
    assert a.get(base).json()[0]["body"] == {"text": "mine"} and len(a.get(base).json()) == 2
    assert memo["user_id"].startswith("r-") and memo["user_id"] != ca
    conn = sqlite3.connect(db_path)
    dump = "\n".join(conn.iterdump())
    conn.close()
    assert ca not in dump and cb not in dump  # the store keeps a hash of the cookie, never the cookie


def test_cookie_flags(app, seeded):
    c = browser(app).get("/").headers["set-cookie"]
    assert c.startswith(f"{READER_COOKIE}=") and "httponly" in c.lower() and "samesite=lax" in c.lower()
    assert "Path=/" in c and "secure" not in c.lower()
    assert "secure" in browser(app, "https://127.0.0.1").get("/").headers["set-cookie"].lower()  # behind HTTPS


def test_cookie_is_kept_or_replaced(app, seeded):
    a = browser(app)
    a.get("/")
    first = a.cookies[READER_COOKIE]
    r = a.get(f"/reports/{seeded}")
    assert r.status_code == 200 and "set-cookie" not in r.headers and a.cookies[READER_COOKIE] == first
    r = browser(app, cookies={READER_COOKIE: "short"}).get("/")  # not a value this app issues: a new reader
    assert r.headers["set-cookie"].startswith(f"{READER_COOKIE}=") and f"{READER_COOKIE}=short" not in r.headers["set-cookie"]
    for path in ("/api/health", "/api/reports"):  # only the pages and the overlay API set it
        assert "set-cookie" not in browser(app).get(path).headers


def test_per_reader_cap(app, seeded, monkeypatch):
    monkeypatch.setattr(server, "MAX_OVERLAYS_PER_READER", 2)
    a, b = browser(app), browser(app)
    base = f"/api/editions/{seeded}/overlays"
    assert [a.post(base, json=MEMO).status_code for _ in range(3)] == [201, 201, 429]
    assert b.post(base, json=MEMO).status_code == 201  # another reader has its own count
    first = a.get(base).json()[0]["id"]
    assert a.delete(f"{base}/{first}").status_code == 204 and a.post(base, json=MEMO).status_code == 201
