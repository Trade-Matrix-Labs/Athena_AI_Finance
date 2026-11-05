"""Ingest one pipeline delivery: hash check, adapt v2 -> v3, validate, store. All or nothing.

python -m athena_app.ingest <delivery_dir> [--status-sidecar <edition status json>] [--quality-disposition ...]
Paths come from flags or ATHENA_DB, ATHENA_UI, ATHENA_CHECKER, ATHENA_FILING.
Reads only <delivery_dir>/DELIVERY-MANIFEST.json, <delivery_dir>/REPORT.json and the edition status sidecar
(--status-sidecar, else <delivery_dir>/EDITION-STATUS.json when present).
"""
import argparse
import collections
import json
import os
import pathlib
import re
import sqlite3
import sys

from . import store
from .adapter import adapt_v2_to_v3, canonical, with_created
from .validate import load_module, validate

# listed from the strictest to the one nearest to accepted / published; a flag may only move left
QUALITY = ("failed", "review_required", "unreviewed", "accepted")
PUBLICATION = ("withdrawn", "draft", "published")
SIDECAR = "EDITION-STATUS.json"
SIDECAR_SCHEMA = "athena-edition-status.v1"
DETAIL = ("delivery_complete_scope", "native_final_verified", "final_store_reopen_verified")
COVERAGE = ("produced", "failed", "planned")


class IngestError(Exception):
    pass


class ValidationRefused(IngestError):
    def __init__(self, errors):
        super().__init__(f"validation refused the delivery: {len(errors)} finding(s)")
        self.errors = errors


def chapters(ui_dir):
    """The app's fixed chapter map (id, title, question), from the Desk's build script."""
    return load_module(pathlib.Path(ui_dir) / "build.py", "athena_ui_build").CHAPTERS


def coverage(manifest, canonical_ids):
    """The manifest's chapter coverage of a partial edition, checked: {produced, failed, planned}, lists of chapter ids
    that together name each of the app's chapters exactly once (planned: not attempted in this run; failed: attempted,
    did not pass the checks, not in REPORT.json). None when the manifest has none (a whole-report delivery)."""
    if "coverage" not in manifest:
        return None
    cov = manifest["coverage"]
    if not isinstance(cov, dict) or set(cov) != set(COVERAGE) \
            or not all(isinstance(cov[k], list) and all(isinstance(i, str) for i in cov[k]) for k in COVERAGE):
        raise IngestError("manifest coverage must be {produced, failed, planned}, each a list of chapter ids")
    ids = [i for k in COVERAGE for i in cov[k]]
    if len(ids) != len(set(ids)) or set(ids) != set(canonical_ids):
        raise IngestError(f"manifest coverage must name each of the {len(canonical_ids)} chapters exactly once: "
                          f"missing {sorted(set(canonical_ids) - set(ids))}, unknown {sorted(set(ids) - set(canonical_ids))}, "
                          f"repeated {sorted(i for i in set(ids) if ids.count(i) > 1)}")
    return cov


def check_scope(detail, cov, n):
    """A stage-scoped delivery_complete ("<stage>: <k> of <n> chapters") must agree with the coverage: true there
    means only that the stage's requested chapters arrived, so partial or complete is read from coverage. Other
    scope wording is free text and is left alone."""
    m = re.fullmatch(r"\S+: (\d+) of (\d+) chapters", str(detail.get("delivery_complete_scope")))
    if cov is not None and m and (int(m[1]), int(m[2])) != (len(cov["produced"]), n):
        raise IngestError(f"status sidecar delivery_complete_scope {detail['delivery_complete_scope']!r} disagrees with "
                          f"manifest coverage ({len(cov['produced'])} of {n} chapters produced)")


def statuses(manifest, report_sha256, quality=None, publication=None, sidecar=None):
    """The four status fields plus their detail. From the pipeline's edition status sidecar when there is one
    (flags may only make it stricter); otherwise conservative defaults."""
    if sidecar:
        side = json.loads(pathlib.Path(sidecar).read_text())
        if side.get("schema") != SIDECAR_SCHEMA:
            raise IngestError(f"status sidecar schema {side.get('schema')!r} is not {SIDECAR_SCHEMA}")
        if side.get("report_sha256") != report_sha256:
            raise IngestError(f"status sidecar is for report {side.get('report_sha256')}, not {report_sha256}")
        if not isinstance(side.get("delivery_complete"), bool) or not isinstance(side.get("native_status"), str) \
                or not side["native_status"]:
            raise IngestError("status sidecar needs a boolean delivery_complete and a native_status")
        out = {k: side.get(k) for k in ("delivery_complete", "native_status", "quality_disposition",
                                        "publication_disposition")}
        detail = {k: side.get(k) for k in DETAIL}
        detail["source"] = "sidecar " + store.sha256(pathlib.Path(sidecar).read_bytes())
    else:
        dc, ns = manifest.get("delivery_complete"), manifest.get("native_status")
        if ns is not None and not isinstance(ns, str):
            raise IngestError("manifest native_status must be a string")
        out = {"delivery_complete": dc if isinstance(dc, bool) else False,  # a FINAL flag is not completeness
               "native_status": ns or "unknown",
               "quality_disposition": "unreviewed", "publication_disposition": "draft"}
        detail = {k: None for k in DETAIL} | {"source": "manifest"}
    for key, flag, order in (("quality_disposition", quality, QUALITY), ("publication_disposition", publication, PUBLICATION)):
        if out[key] not in order or (flag and flag not in order):
            raise IngestError(f"{key} must be one of {order}")
        if flag:
            if order.index(flag) > order.index(out[key]):
                raise IngestError(f"--{key.replace('_', '-')} {flag} would loosen {out[key]}; flags may only make it stricter")
            out[key] = flag
    return out, detail


def tighten(conn, old, status, quality, publication, notes):
    """Re-ingest of a stored report: its status may only move stricter. A looser explicit flag refuses; a looser
    sidecar or default is ignored (with a note). Returns True when the stored status changed."""
    ed = store.get_edition(conn, old)["status"]
    changed = {}
    for key, flag, order in (("quality_disposition", quality, QUALITY), ("publication_disposition", publication, PUBLICATION)):
        new, have = status[key], ed[key]
        if order.index(new) < order.index(have):
            changed[key] = new
        elif order.index(new) > order.index(have):
            if flag:
                raise IngestError(f"--{key.replace('_', '-')} {flag} would loosen the stored {have}; "
                                  "a stored edition may only become stricter")
            notes.append(f"ignored: {key} {new} would loosen the stored {have}")
    for key in ("delivery_complete", "native_status"):
        if status[key] != ed[key]:
            notes.append(f"ignored: {key} {status[key]!r} differs from the stored {ed[key]!r}; it is fixed at first ingest")
    for key, new in changed.items():
        conn.execute(f"UPDATE editions SET {key} = ? WHERE id = ?", (new, old))
        notes.append(f"tightened: {key} {ed[key]} -> {new}")
    return bool(changed)


def ingest(conn, delivery_dir, *, ui_dir, checker, filing, quality=None, publication=None, status_sidecar=None,
           notes=None):
    """Return (edition_id, state), state one of "created", "tightened", "unchanged" (a report already stored).
    Raises IngestError (or ValidationRefused) and stores nothing on failure. Notes for the operator are appended
    to `notes` when given."""
    notes = [] if notes is None else notes
    d = pathlib.Path(delivery_dir)
    manifest = json.loads((d / "DELIVERY-MANIFEST.json").read_text())
    raw = (d / "REPORT.json").read_bytes()
    got = store.sha256(raw)
    want = manifest.get("report_sha256") or manifest.get("files", {}).get("REPORT.json", {}).get("sha256")
    if not want:
        raise IngestError("manifest carries no REPORT.json sha256")
    if got != want:
        raise IngestError(f"REPORT.json sha256 {got} != manifest {want}")
    sidecar = status_sidecar or (d / SIDECAR if (d / SIDECAR).is_file() else None)
    status, detail = statuses(manifest, got, quality, publication, sidecar)
    chs = chapters(ui_dir)
    cov = coverage(manifest, [c[0] for c in chs])
    check_scope(detail, cov, len(chs))
    conn.execute("BEGIN IMMEDIATE")
    try:
        old = conn.execute("SELECT id FROM editions WHERE source_sha256 = ?", (got,)).fetchone()
        if old:
            # the stored coverage and scope were checked against these same REPORT.json bytes at first ingest
            have = store.get_edition(conn, old["id"])
            norm = lambda c: c and {k: sorted(c[k]) for k in COVERAGE}
            if norm(have["producer"].get("coverage")) != norm(cov):
                raise IngestError(f"manifest coverage {cov} is not the stored edition's {have['producer'].get('coverage')}; "
                                  "coverage is fixed at first ingest")
            scope, stored = detail["delivery_complete_scope"], have["status_detail"].get("delivery_complete_scope")
            if scope is not None and scope != stored:
                raise IngestError(f"status sidecar delivery_complete_scope {scope!r} is not the stored edition's {stored!r}; "
                                  "it is fixed at first ingest")
            state = "tightened" if tighten(conn, old["id"], status, quality, publication, notes) else "unchanged"
            conn.execute("COMMIT")
            return old["id"], state
        doc = json.loads(raw)
        f = doc["filing"]
        number = 1 + conn.execute("SELECT coalesce(max(number), 0) FROM editions WHERE accession = ? AND language = ?",
                                  (f["accession"], doc["language"])).fetchone()[0]
        created = store.now()
        v3 = adapt_v2_to_v3(doc, {"chapters": chs, "edition_number": number})
        if cov is not None and set(cov["produced"]) != {c["id"] for c in v3["sections"]}:
            raise IngestError(f"manifest coverage produced {sorted(cov['produced'])} is not the chapters REPORT.json "
                              f"carries {sorted(c['id'] for c in v3['sections'])}")
        errors, findings, info = validate(with_created(v3, created), checker, filing)
        if errors:
            raise ValidationRefused(errors)
        if findings and (status["quality_disposition"] == "accepted" or status["publication_disposition"] == "published"):
            raise IngestError(f"{len(findings)} open review finding(s): the edition cannot be accepted or published")
        # coverage is kept for display only: the stored report holds just the produced chapters
        producer = {k: manifest[k] for k in ("source", "run_id", "producer", "model_route", "coverage") if k in manifest}
        eid = store.insert_edition(
            conn, filing=f, language=doc["language"], number=number, source_bytes=raw, doc_bytes=canonical(v3),
            status=status, status_detail=detail, producer=producer, filing_sha256=store.sha256(pathlib.Path(filing).read_bytes()),
            validation={"review_findings": findings, "orphan_facts": len(info["orphan_facts"]),
                        "orphan_sources": len(info["orphan_sources"]), "counts": info["counts"]},
            created_at=created)
        conn.execute("COMMIT")
        return eid, "created"
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


def main(argv=None):
    env = os.environ.get
    p = argparse.ArgumentParser(prog="python -m athena_app.ingest", description=__doc__.splitlines()[0])
    p.add_argument("delivery_dir")
    p.add_argument("--db", default=env("ATHENA_DB", "athena.db"))
    p.add_argument("--ui", default=env("ATHENA_UI"), help="Desk UI folder (build.py, src/, fonts/)")
    p.add_argument("--checker", default=env("ATHENA_CHECKER"), help="path to check_report.py")
    p.add_argument("--filing", default=env("ATHENA_FILING"), help="the filing .htm the report cites")
    p.add_argument("--quality-disposition", choices=QUALITY)
    p.add_argument("--publication-disposition", choices=PUBLICATION)
    p.add_argument("--status-sidecar", help=f"edition status JSON ({SIDECAR_SCHEMA}); default <delivery_dir>/{SIDECAR}")
    a = p.parse_args(argv)
    for k in ("ui", "checker", "filing"):
        if not getattr(a, k):
            p.error(f"--{k} (or ATHENA_{k.upper()}) is required")
    notes = []
    try:
        conn = store.connect(a.db)
    except sqlite3.Error as e:
        print(f"REFUSED: database {a.db}: {e}", file=sys.stderr)
        return 1
    try:
        eid, state = ingest(conn, a.delivery_dir, ui_dir=a.ui, checker=a.checker, filing=a.filing,
                            quality=a.quality_disposition, publication=a.publication_disposition,
                            status_sidecar=a.status_sidecar, notes=notes)
    except ValidationRefused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        for x in e.errors:
            print("  " + x, file=sys.stderr)
        return 1
    except (IngestError, ValueError, KeyError, OSError) as e:  # adapter, JSON and file errors refuse too
        print(f"REFUSED: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    except sqlite3.Error as e:
        print(f"REFUSED: database {a.db}: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    else:
        ed = store.get_edition(conn, eid)
        word = {"created": "stored", "tightened": "already stored; status tightened on", "unchanged": "already stored"}[state]
        print(f"{word} edition {eid} (R{ed['number']}, doc {ed['doc_sha256'][:12]})")
        for n in notes:
            print(n)
        print("status " + json.dumps(ed["status"], sort_keys=True))
        cov = ed["producer"].get("coverage")
        if cov:  # a partial edition: its delivery_complete covers the stage only
            print(f"coverage {len(cov['produced'])} of {sum(map(len, cov.values()))} chapters produced, "
                  f"{len(cov['failed'])} failed, {len(cov['planned'])} planned")
        rf = ed["review_findings"]
        print(f"open review findings {rf['count']}: " + json.dumps(dict(collections.Counter(f["class"] for f in rf["items"]))))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
