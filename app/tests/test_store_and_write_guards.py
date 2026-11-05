"""Regressions: the write limit vs HTTP framing, INSERT OR REPLACE vs the immutability guards, and overlay ids that
are never reused."""
import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from athena_app import store
from athena_app.server import MAX_BODY, create_app
from conftest import UI

LOCAL = "http://127.0.0.1"
JSON = {"content-type": "application/json"}
READER = "fixture-reader-cookie-0001"  # one reader for the client and asgi_post


def overlays_on(client, eid):
    return client.get(f"/api/editions/{eid}/overlays").json()


# ---- write limit vs HTTP framing ----

@pytest.fixture
def client(db_path, seeded):
    with TestClient(create_app(db_path, UI), base_url=LOCAL, headers=JSON, cookies={"athena_reader": READER}) as c:
        yield c


def asgi_post(app, path, headers, chunks):
    """POST through the bare ASGI interface, so the declared and the real framing can differ. Returns (status,
    number of body chunks the app took)."""
    taken, status = [], []
    feed = iter(chunks)

    async def receive():
        try:
            c = next(feed)
        except StopIteration:
            return {"type": "http.disconnect"}
        taken.append(c)
        return {"type": "http.request", "body": c, "more_body": True if len(taken) < len(chunks) else False}

    async def send(m):
        if m["type"] == "http.response.start":
            status.append(m["status"])

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "path": path,
             "raw_path": path.encode(), "query_string": b"", "scheme": "http", "server": ("127.0.0.1", 80),
             "client": ("127.0.0.1", 1), "root_path": "",
             "headers": [(b"host", b"127.0.0.1"), (b"cookie", b"athena_reader=" + READER.encode())] + [(k.encode(), v.encode()) for k, v in headers.items()]}
    asyncio.run(app(scope, receive, send))
    return status[0], len(taken)


def memo(n):
    return json.dumps({"kind": "memo", "body": {"text": "x" * n}}).encode()


def test_chunked_body_over_the_limit_is_not_stored(client, seeded):
    """Content-Length: 1 plus Transfer-Encoding: chunked with a 66 KB body used to return 201 and store it."""
    base = f"/api/editions/{seeded}/overlays"
    body = memo(MAX_BODY + 1024)
    r = client.post(base, content=body, headers={"content-length": "1", "transfer-encoding": "chunked"})
    assert r.status_code == 400 and overlays_on(client, seeded) == []
    # Transfer-Encoding alone stays 411 (the existing "Content-Length required" answer)
    r = client.post(base, content=iter([body]), headers={"transfer-encoding": "chunked"})
    assert r.status_code == 411 and overlays_on(client, seeded) == []


def test_real_bytes_are_capped_and_counted(client, seeded):
    app, path = client.app, f"/api/editions/{seeded}/overlays"
    ok = memo(10)
    assert asgi_post(app, path, JSON | {"content-length": str(len(ok))}, [ok])[0] == 201
    # declared small, really large, no Transfer-Encoding: 413, and the app stops reading at the limit
    big = [b"x" * 1024] * 1000
    status, taken = asgi_post(app, path, JSON | {"content-length": "1000"}, big)
    assert status == 413 and taken <= MAX_BODY // 1024 + 1
    # declared length differs from the received bytes, in both directions
    assert asgi_post(app, path, JSON | {"content-length": "100"}, [memo(10)])[0] == 400
    assert asgi_post(app, path, JSON | {"content-length": str(len(ok))}, [ok + b" "])[0] == 400
    assert asgi_post(app, path, JSON | {"content-length": "²"}, [ok])[0] == 413  # not a 500
    # the depth check still runs on the bounded bytes
    deep = b'{"kind":"memo","body":{"a":' + b"[" * 20000 + b"]" * 20000 + b"}}"
    assert asgi_post(app, path, JSON | {"content-length": str(len(deep))}, [deep[:30000], deep[30000:]])[0] == 422
    assert len(overlays_on(client, seeded)) == 1  # only the one valid memo


# ---- INSERT OR REPLACE vs the immutability guards ----

def plain(db_path):
    c = sqlite3.connect(db_path, isolation_level=None)  # default pragmas: foreign_keys=0, recursive_triggers=0
    c.row_factory = sqlite3.Row
    return c


CONNECTIONS = [pytest.param(store.connect, id="app"), pytest.param(plain, id="plain-sqlite3")]


def snapshot(conn):
    return [[tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY 1")] for t in ("documents", "editions", "overlays")]


def edition_row(conn, **over):
    row = dict(conn.execute("SELECT * FROM editions WHERE id = 1").fetchone()) | over
    return "INSERT OR REPLACE INTO editions (%s) VALUES (%s)" % (",".join(row), ",".join("?" * len(row))), list(row.values())


def test_app_connections_enable_recursive_triggers(db_path, seeded):
    conn = store.connect(db_path)
    assert conn.execute("PRAGMA recursive_triggers").fetchone()[0] == 1 and conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()


@pytest.mark.parametrize("opener", CONNECTIONS)
def test_replace_cannot_rewrite_documents_or_editions(db_path, seeded, opener):
    """REPLACE (and any other duplicate insert) on an existing hash or edition identity fails and changes nothing."""
    conn = opener(db_path)
    ed = store.get_edition(conn, seeded)
    sha, other = ed["doc_sha256"], ed["source_sha256"]
    ok = dict(quality_disposition="accepted", publication_disposition="published",
              validation_json=json.dumps({"review_findings": []}))
    stmts = [
        ("INSERT OR REPLACE INTO documents (sha256, bytes) VALUES (?, ?)", (sha, b'{"replaced":true}')),
        ("INSERT OR REPLACE INTO documents (sha256, bytes) SELECT sha256, bytes FROM documents WHERE sha256 = ?", (sha,)),
        ("INSERT OR IGNORE INTO documents (sha256, bytes) VALUES (?, ?)", (sha, b"x")),
        ("INSERT INTO documents (sha256, bytes) VALUES (?, ?)", (sha, b"x")),
        edition_row(conn, **ok),  # same row, accepted/published, no findings
        edition_row(conn, **ok, number=7, doc_sha256="n1", source_sha256="n2"),  # same id only
        edition_row(conn, **ok, id=9, number=7, doc_sha256="n1", source_sha256=other),  # source hash only
        edition_row(conn, **ok, id=9, number=7, doc_sha256=sha, source_sha256="n2"),  # doc hash only
        edition_row(conn, **ok, id=9, source_sha256="n2", doc_sha256="n1"),  # (accession, language, number) only
    ]
    conn.execute("INSERT INTO documents (sha256, bytes) VALUES ('n1', x'00')")
    conn.execute("INSERT INTO documents (sha256, bytes) VALUES ('n2', x'00')")
    before = snapshot(conn)
    for sql, args in stmts:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(sql, args)
        assert snapshot(conn) == before, sql
    conn.close()


def test_put_document_is_idempotent(db_path):
    conn = store.connect(db_path)
    assert store.put_document(conn, b"{}") == store.put_document(conn, b"{}")
    assert conn.execute("SELECT count(*) FROM documents").fetchone()[0] == 1
    conn.close()


# ---- overlay ids are never reused ----

def test_overlay_ids_are_not_reused(client, seeded):
    base = f"/api/editions/{seeded}/overlays"
    first = client.post(base, json={"kind": "memo", "body": {}}).json()["id"]
    assert client.delete(f"{base}/{first}").status_code == 204
    second = client.post(base, json={"kind": "memo", "body": {}}).json()["id"]
    assert second > first  # a stale tab holding `first` finds nothing
    assert client.patch(f"{base}/{first}", json={"body": {"t": 1}}).status_code == 404
    assert client.delete(f"{base}/{first}").status_code == 404


def old_database(path, upto=3):
    """A database as the shipped v3 store left it: migrations 001..upto only, with a filing, an edition and a few
    overlays (one reply chain), the last one deleted."""
    conn = sqlite3.connect(path, isolation_level=None)
    for f in sorted(store.MIGRATIONS.glob("*.sql"))[:upto]:
        for stmt in store.statements(f.read_text()):
            conn.execute(stmt)
    conn.execute(f"PRAGMA user_version={upto}")
    conn.execute("INSERT INTO filings VALUES ('a', 'Issuer', 'T', '10-K', 2025, '2025-12-31', NULL)")
    conn.execute("INSERT INTO documents VALUES ('d', x'7b7d'), ('s', x'7b7d')")
    conn.execute("INSERT INTO editions (accession, language, number, doc_sha256, source_sha256, native_status,"
                 " quality_disposition, publication_disposition, producer_json, validation_json, created_at)"
                 " VALUES ('a', 'en', 1, 'd', 's', 'HOLD', 'review_required', 'draft', '{}', '{\"review_findings\":[]}', 't')")
    return conn


def add_old(conn, parent=None):
    return conn.execute("INSERT INTO overlays (user_id, edition_id, kind, parent_id, anchor_json, body_json, created_at)"
                        " VALUES ('demo', 1, 'memo', ?, '{}', '{\"k\":1}', 't')", (parent,)).lastrowid


def test_migration_rebuilds_overlays_keeping_rows(tmp_path):
    path = tmp_path / "old.db"
    conn = old_database(path)
    one = add_old(conn)
    two = add_old(conn, one)
    three = add_old(conn, two)
    conn.execute("DELETE FROM overlays WHERE id = ?", (three,))
    rows = [tuple(r) for r in conn.execute("SELECT * FROM overlays ORDER BY id")]
    conn.close()

    conn = store.connect(path)  # runs 004 and 005
    assert [tuple(r) for r in conn.execute("SELECT * FROM overlays ORDER BY id")] == rows and len(rows) == 2
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(list(store.MIGRATIONS.glob("*.sql")))
    assert "AUTOINCREMENT" in conn.execute("SELECT sql FROM sqlite_master WHERE name = 'overlays'").fetchone()[0]
    assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'new_overlays'").fetchone()
    assert [r["name"] for r in conn.execute("PRAGMA index_list(overlays)")] == ["overlays_edition"]
    assert sorted((r["from"], r["table"], r["to"]) for r in conn.execute("PRAGMA foreign_key_list(overlays)")) == \
        [("edition_id", "editions", "id"), ("parent_id", "overlays", "id"), ("user_id", "users", "id")]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    with pytest.raises(sqlite3.IntegrityError):  # the parent_id reference is enforced
        conn.execute("DELETE FROM overlays WHERE id = ?", (one,))
    newest = add_old(conn)
    conn.execute("DELETE FROM overlays WHERE id = ?", (newest,))
    assert add_old(conn) > newest  # ids of deleted rows are not reissued
    conn.close()


def test_migration_stops_on_a_dangling_reference(tmp_path):
    path = tmp_path / "bad.db"
    conn = old_database(path)
    add_old(conn, parent=99)  # foreign_keys is off on this raw connection
    conn.close()
    with pytest.raises(sqlite3.IntegrityError, match="foreign key check"):
        store.connect(path)
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 3
    assert "AUTOINCREMENT" not in conn.execute("SELECT sql FROM sqlite_master WHERE name = 'overlays'").fetchone()[0]
    conn.close()
