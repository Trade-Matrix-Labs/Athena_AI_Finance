"""Shared fixtures. External inputs come from ATHENA_UI, ATHENA_CHECKER and ATHENA_FILING; by default they
are looked up next to this app folder (ui/, content/check_report.py, inputs/<filing>.htm). Missing inputs fail
the run, unless ATHENA_SKIP_MISSING_INPUTS=1 asks to skip it."""
import json
import os
import pathlib

import pytest

from athena_app import store
from athena_app.adapter import adapt_v2_to_v3
from athena_app.ingest import chapters as load_chapters
from athena_app.ingest import ingest

APP = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = APP / "fixtures" / "r14"
UI = pathlib.Path(os.environ.get("ATHENA_UI", APP.parent / "ui"))
CHECKER = pathlib.Path(os.environ.get("ATHENA_CHECKER", APP.parent / "content" / "check_report.py"))
FILING = pathlib.Path(os.environ.get("ATHENA_FILING", APP.parent / "inputs" / "pltr-20251231.htm"))

missing = [p for p in (UI / "build.py", CHECKER, FILING) if not p.exists()]
if missing and os.environ.get("ATHENA_SKIP_MISSING_INPUTS") == "1":
    pytest.skip(f"external inputs missing: {missing}", allow_module_level=True)
if missing:
    raise RuntimeError(f"external inputs missing: {missing} (set ATHENA_UI, ATHENA_CHECKER, ATHENA_FILING, "
                       "or ATHENA_SKIP_MISSING_INPUTS=1 to skip the suite)")

META = {"edition_number": 1}


@pytest.fixture(scope="session")
def chapters():
    return load_chapters(UI)


@pytest.fixture(scope="session")
def v2_bytes():
    return (FIXTURE / "REPORT.json").read_bytes()


@pytest.fixture(scope="session")
def v2(v2_bytes):
    return json.loads(v2_bytes)


@pytest.fixture(scope="session")
def v3(v2, chapters):
    return adapt_v2_to_v3(v2, {**META, "chapters": chapters})


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "athena.db"


def ingest_r14(db_path, delivery=FIXTURE, **kw):
    conn = store.connect(db_path)
    try:
        return ingest(conn, delivery, ui_dir=UI, checker=CHECKER, filing=FILING, **kw)
    finally:
        conn.close()


@pytest.fixture
def seeded(db_path):
    """R14 ingested for real (its sidecar sets review_required; findings are stored as review findings)."""
    eid, state = ingest_r14(db_path)
    assert state == "created"
    return eid
