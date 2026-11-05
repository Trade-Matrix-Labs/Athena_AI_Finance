"""SQLite store: plain SQL migrations, WAL, no ORM."""
import datetime
import hashlib
import json
import pathlib
import sqlite3
import time

MIGRATIONS = pathlib.Path(__file__).resolve().parent / "migrations"
STATUS = ("delivery_complete", "native_status", "quality_disposition", "publication_disposition")


def now():
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def connect(path, migrate=True):
    conn = sqlite3.connect(path, isolation_level=None, timeout=10)  # autocommit; transactions are explicit
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=10000")  # before anything that may wait for another writer
    for attempt in range(50):
        # Switching a brand-new file to WAL can fail with "database is locked" despite the busy timeout when
        # another process opens it at the same moment (observed); WAL then persists in the file. Retry briefly.
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            break
        except sqlite3.OperationalError as e:
            if "locked" not in str(e) or attempt == 49:
                raise
            time.sleep(0.05)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA recursive_triggers=ON")  # REPLACE's implicit DELETE then fires the delete guards too
    if migrate:
        run_migrations(conn)
    return conn


def statements(sql):
    """Split a migration file into whole statements (trigger bodies included), so it can run inside our transaction."""
    buf = ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            yield buf
            buf = ""
    if any(x.strip() and not x.strip().startswith("--") for x in buf.splitlines()):
        raise ValueError(f"unterminated SQL statement: {buf.strip()[:60]!r}")


def run_migrations(conn):
    """Apply pending migrations under one write lock: a second process waits (busy timeout), then sees the new
    user_version and applies nothing twice. Foreign keys are off while migrating (a table rebuild needs that, and
    the PRAGMA is a no-op inside a transaction) and are checked before the commit."""
    conn.execute("PRAGMA foreign_keys=OFF")
    conn.execute("BEGIN IMMEDIATE")
    try:
        have = conn.execute("PRAGMA user_version").fetchone()[0]
        applied = False
        for f in sorted(MIGRATIONS.glob("*.sql")):
            n = int(f.name.split("_")[0])
            if n > have:
                for stmt in statements(f.read_text()):
                    conn.execute(stmt)
                conn.execute(f"PRAGMA user_version={n}")
                applied = True
        if applied and (bad := conn.execute("PRAGMA foreign_key_check").fetchall()):
            raise sqlite3.IntegrityError(f"foreign key check failed after migration: {len(bad)} row(s)")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")


def put_document(conn, data):
    h = sha256(data)
    # not INSERT OR IGNORE: the BEFORE INSERT guard (migration 004) aborts on an existing hash whatever the clause
    conn.execute("INSERT INTO documents (sha256, bytes) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM documents WHERE sha256 = ?)",
                 (h, data, h))
    return h


def insert_edition(conn, *, filing, language, number, source_bytes, doc_bytes, status, producer, validation,
                   status_detail=None, filing_sha256=None, created_at=None):
    """Insert one edition and its documents. The caller owns the transaction."""
    old = conn.execute("SELECT issuer, form FROM filings WHERE accession = ?", (filing["accession"],)).fetchone()
    if old is None:
        conn.execute("INSERT INTO filings VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (filing["accession"], filing["issuer"], filing.get("ticker"), filing["form"],
                      filing.get("fiscal_year"), filing.get("period_end"), filing_sha256))
    elif (old["issuer"], old["form"]) != (filing["issuer"], filing["form"]):
        raise ValueError(f"filing {filing['accession']} is already stored with other metadata")
    src, doc = put_document(conn, source_bytes), put_document(conn, doc_bytes)
    cur = conn.execute(
        "INSERT INTO editions (accession, language, number, doc_sha256, source_sha256, delivery_complete,"
        " native_status, quality_disposition, publication_disposition, producer_json, validation_json, created_at,"
        " status_detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (filing["accession"], language, number, doc, src,
         None if status["delivery_complete"] is None else int(bool(status["delivery_complete"])),
         status["native_status"], status["quality_disposition"], status["publication_disposition"],
         json.dumps(producer, sort_keys=True), json.dumps(validation, sort_keys=True), created_at or now(),
         json.dumps(status_detail or {}, sort_keys=True)))
    return cur.lastrowid


EDITION_SQL = ("SELECT e.*, f.issuer, f.ticker, f.form, f.fiscal_year, f.period_end"
               " FROM editions e JOIN filings f USING (accession)")


def edition_dict(r):
    validation = json.loads(r["validation_json"])
    findings = validation.pop("review_findings", [])
    return {
        "id": r["id"], "number": r["number"], "language": r["language"], "created_at": r["created_at"],
        "doc_sha256": r["doc_sha256"], "source_sha256": r["source_sha256"],
        "filing": {k: r[k] for k in ("accession", "issuer", "ticker", "form", "fiscal_year", "period_end")},
        "status": {"delivery_complete": None if r["delivery_complete"] is None else bool(r["delivery_complete"]),
                   **{k: r[k] for k in STATUS[1:]}},
        "producer": json.loads(r["producer_json"]),
        "status_detail": json.loads(r["status_detail_json"]),
        "review_findings": {"count": sum(f["status"] == "open" for f in findings), "items": findings},
        "validation": validation,
    }


def list_editions(conn):
    return [edition_dict(r) for r in conn.execute(EDITION_SQL + " ORDER BY e.id")]


def get_edition(conn, edition_id):
    r = conn.execute(EDITION_SQL + " WHERE e.id = ?", (edition_id,)).fetchone()
    return r and edition_dict(r)


def latest_edition_id(conn):
    r = conn.execute("SELECT max(id) FROM editions").fetchone()
    return r[0]


def get_document(conn, sha):
    r = conn.execute("SELECT bytes FROM documents WHERE sha256 = ?", (sha,)).fetchone()
    return r and json.loads(r[0])


# ---- personal overlays (memo | thread | revision); never touch an edition ----

def overlay_dict(r):
    return {"id": r["id"], "edition_id": r["edition_id"], "user_id": r["user_id"], "kind": r["kind"],
            "parent_id": r["parent_id"], "anchor": json.loads(r["anchor_json"]), "body": json.loads(r["body_json"]),
            "created_at": r["created_at"], "updated_at": r["updated_at"]}


def list_overlays(conn, edition_id, user_id, kind=None):
    q, a = "SELECT * FROM overlays WHERE edition_id = ? AND user_id = ?", [edition_id, user_id]
    if kind:
        q, a = q + " AND kind = ?", a + [kind]
    return [overlay_dict(r) for r in conn.execute(q + " ORDER BY id", a)]


def ensure_user(conn, user_id):
    """A reader's users row (the overlays' foreign key), made on first write."""
    conn.execute("INSERT INTO users (id, display_name) SELECT ?, 'Reader' WHERE NOT EXISTS"
                 " (SELECT 1 FROM users WHERE id = ?)", (user_id, user_id))


def count_overlays(conn, user_id):
    return conn.execute("SELECT count(*) FROM overlays WHERE user_id = ?", (user_id,)).fetchone()[0]


def get_overlay(conn, edition_id, user_id, overlay_id):
    r = conn.execute("SELECT * FROM overlays WHERE id = ? AND edition_id = ? AND user_id = ?",
                     (overlay_id, edition_id, user_id)).fetchone()
    return r and overlay_dict(r)


def add_overlay(conn, edition_id, user_id, kind, anchor, body, parent_id=None):
    cur = conn.execute("INSERT INTO overlays (user_id, edition_id, kind, parent_id, anchor_json, body_json, created_at)"
                       " VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (user_id, edition_id, kind, parent_id, json.dumps(anchor), json.dumps(body), now()))
    return get_overlay(conn, edition_id, user_id, cur.lastrowid)


def update_overlay(conn, edition_id, user_id, overlay_id, anchor=None, body=None):
    sets = [("anchor_json", anchor), ("body_json", body)]
    sets = [(k, json.dumps(v)) for k, v in sets if v is not None]
    conn.execute(f"UPDATE overlays SET {', '.join([k + ' = ?' for k, _ in sets] + ['updated_at = ?'])}"
                 " WHERE id = ? AND edition_id = ? AND user_id = ?",
                 [v for _, v in sets] + [now(), overlay_id, edition_id, user_id])
    return get_overlay(conn, edition_id, user_id, overlay_id)


def delete_overlay(conn, edition_id, user_id, overlay_id):
    return conn.execute("DELETE FROM overlays WHERE id = ? AND edition_id = ? AND user_id = ?",
                        (overlay_id, edition_id, user_id)).rowcount
