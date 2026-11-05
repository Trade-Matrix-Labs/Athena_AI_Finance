"""Live report jobs: judge API, runner API, availability,
admission and caps, claim tokens, sequence numbers and operation ids, delivery binding and ingest, the operator
command, the fake runner. Every test makes its own token, access code and config in a temp folder."""
import base64
import contextlib
import json
import re
import secrets
import socket
import sqlite3
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn
from fastapi.testclient import TestClient

from athena_app import fake_runner, jobs, jobs_admin, store
from athena_app.server import create_app
from conftest import CHECKER, FILING, FIXTURE, UI
from test_ingest import R14_STATUS, copy_delivery, edit_json

LOCAL = "http://127.0.0.1"
ACCESS = "judge-access-code-7f3a9c"  # at least 20 characters
FILING_ID = "pltr-fy2025-10k"
NAMES = ("REPORT.json", "DELIVERY-MANIFEST.json", "EDITION-STATUS.json")
PLTR = {"filing_id": FILING_ID, "issuer": "Palantir Technologies Inc.", "form": "10-K", "period": "FY2025",
        "language": "en", "accession": "0001321655-26-000011", "filing_path": str(FILING), "checker_path": str(CHECKER)}


def write_config(tmp_path, **over):
    token = secrets.token_hex(16)
    (tmp_path / "runner.token").write_text(token + "\n")
    (tmp_path / "access.code").write_text(ACCESS + "\n")
    cfg = {"enabled": True, "access_code_file": "access.code", "runner_token_file": "runner.token", "jobs_dir": "jobs",
           "max_active": 1, "max_jobs_per_day": 10, "max_jobs_total": 20, "catalog": [PLTR]}
    path = tmp_path / "jobs.json"
    path.write_text(json.dumps(cfg | over))
    return path, token


def auth(token, claim_token=None):
    return {"authorization": f"Bearer {token}"} | ({"x-claim-token": claim_token} if claim_token is not None else {})


def avail(c, token, state="available", reason=None):
    return c.post("/api/runner/availability", json={"state": state, "reason": reason}, headers=auth(token))


@pytest.fixture
def jobs_app(db_path, tmp_path):
    """make(available=True, **config overrides) -> (TestClient, runner token); the runner has reported available."""
    def make(available=True, **over):
        cfg, token = write_config(tmp_path, **over)
        c = TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL)
        if available:
            assert avail(c, token).status_code == 200
        return c, token
    return make


def ask(c, client_id="browser-a", request_id=None, **over):
    body = {"filing_id": FILING_ID, "language": "en", "client_request_id": request_id or secrets.token_hex(8),
            "client_id": client_id, "access_code": ACCESS}
    return c.post("/api/jobs", json=body | over)


def claim(c, token, runner_id="runner-1", crid=None):
    return c.post("/api/runner/claim", headers=auth(token),
                  json={"runner_id": runner_id, "claim_request_id": crid or f"claim-{secrets.token_hex(8)}"})


def as_runner(c, token, claim_token, path, body):
    return c.post(path, json=body, headers=auth(token, claim_token))


def started(c, token, **ask_over):
    """A job asked for and claimed by runner-1: (job_id, claim token)."""
    jid = ask(c, **ask_over).json()["job_id"]
    got = claim(c, token).json()
    assert got["job_id"] == jid and got["state"] == "claimed"
    return jid, got["claim_token"]


def ev(jid, seq, stage="chapters", status="started", **kw):
    return {"job_id": jid, "seq": seq, "stage": stage, "status": status, "ts": "2026-11-02T15:00:00Z", **kw}


def files_of(src=FIXTURE):
    return {n: base64.b64encode((src / n).read_bytes()).decode() for n in NAMES if (src / n).is_file()}


def deliver(c, token, ct, jid, files=None, op="op-delivery-1"):
    return as_runner(c, token, ct, f"/api/runner/jobs/{jid}/delivery",
                     {"operation_id": op, "files": files_of() if files is None else files})


def result(c, token, ct, jid, outcome="failed", reason="engine_error", op="op-result-1", **kw):
    return as_runner(c, token, ct, f"/api/runner/jobs/{jid}/result",
                     {"operation_id": op, "outcome": outcome, "reason": reason, **kw})


def readback(c, token, ct, jid):
    return c.get(f"/api/runner/jobs/{jid}", headers=auth(token, ct))


def refused(r, status, code):
    assert (r.status_code, r.json().get("code")) == (status, code), r.json()


def sql(db_path, query, *args):
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            return conn.execute(query, args).fetchall()
    finally:
        conn.close()


# ---- delivery binding, claim ownership and unknown jobs ----

def test_delivery_is_bound_to_the_jobs_filing_and_language(jobs_app, db_path, tmp_path):
    """A report for another filing or language never makes a job ready, also when ingest finds the report
    already stored (its dedup path returns the stored edition before any other check)."""
    other = tmp_path / "acme.htm"
    other.write_text("<html><body>Another filing.</body></html>")
    ko = PLTR | {"filing_id": "pltr-fy2025-10k-ko", "language": "ko"}
    acme = PLTR | {"filing_id": "acme-fy2025-10k", "issuer": "Acme Corp", "accession": "0000000001-26-000001",
                   "filing_path": str(other)}
    c, token = jobs_app(max_active=5, catalog=[PLTR, ko, acme])
    ko_report = files_of(copy_delivery(tmp_path / "ko", edit_json(lambda d: d.update(language="ko"))))
    jid, ct = started(c, token, client_id="a")
    job = deliver(c, token, ct, jid, ko_report).json()  # an en job, a ko report
    assert (job["state"], job["error"]["code"], job["edition_id"]) == ("failed", "language_mismatch", None)
    assert sql(db_path, "SELECT count(*) FROM editions") == [(0,)]
    jid, ct = started(c, token, client_id="b")
    assert deliver(c, token, ct, jid).json()["state"] == "ready"  # the PLTR en report is stored now
    for client_id, filing_id, language, code in [("c", "acme-fy2025-10k", "en", "filing_mismatch"),
                                                 ("d", "pltr-fy2025-10k-ko", "ko", "language_mismatch")]:
        jid, ct = started(c, token, client_id=client_id, filing_id=filing_id, language=language)
        job = deliver(c, token, ct, jid).json()  # the stored PLTR en report, again
        assert (job["state"], job["error"]["code"], job["edition_id"]) == ("failed", code, None)
        assert c.get(f"/api/jobs/{jid}").json()["error"] == {"code": code, "count": 0}
    assert sql(db_path, "SELECT count(*) FROM editions") == [(1,)]


def test_claim_token_is_ownership(jobs_app, db_path):
    """The runner token plus an X-Runner-Id naming the claimant do not let a second process write to a job;
    only the job's claim token does. The app stores only its hash."""
    c, token = jobs_app(max_active=2)
    jid, ct = started(c, token, client_id="a")
    _, other_ct = started(c, token, client_id="b")
    assert ct != other_ct and re.fullmatch(r"[0-9a-f]{64}", ct)
    for extra in ({}, {"x-runner-id": "runner-1"}, {"x-claim-token": "0" * 64}, {"x-claim-token": other_ct},
                  {"x-claim-token": ""}):
        headers = auth(token) | extra
        for path, body in [("events", [ev(jid, 1)]), ("delivery", {"operation_id": "op-1", "files": files_of()}),
                           ("result", {"operation_id": "op-2", "outcome": "refused", "reason": "stopped"})]:
            refused(c.post(f"/api/runner/jobs/{jid}/{path}", json=body, headers=headers), 403, "bad_claim_token")
        refused(c.get(f"/api/runner/jobs/{jid}", headers=headers), 403, "bad_claim_token")
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "claimed"  # nothing happened
    assert sql(db_path, "SELECT claim_token_sha256 FROM jobs WHERE job_id = ?", jid) == [(store.sha256(ct.encode()),)]
    assert ct not in json.dumps(sql(db_path, "SELECT * FROM jobs")) and ct not in c.get(f"/api/jobs/{jid}").text
    assert result(c, token, ct, jid, "refused", "stopped").json()["state"] == "refused"


def test_unknown_job_keeps_counting(jobs_app, db_path):
    """A job that reads unknown keeps the active slot and its browser's; it is never handed out again, and
    only its claimant may still report on it."""
    c, token = jobs_app(stale_minutes=20)
    jid, ct = started(c, token, client_id="a", request_id="req-a")
    as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", [ev(jid, 1)])
    sql(db_path, "UPDATE jobs SET seen_at = ? WHERE job_id = ?", jobs.ago(19), jid)
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "running"
    sql(db_path, "UPDATE jobs SET seen_at = ? WHERE job_id = ?", jobs.ago(21), jid)
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "unknown"
    assert ask(c, client_id="a", request_id="req-a").json() == {"job_id": jid, "state": "unknown"}
    refused(ask(c, client_id="a"), 429, "rate_limited")
    refused(ask(c, client_id="b"), 503, "busy")
    assert claim(c, token, "runner-2").status_code == 204  # never handed out again
    assert sql(db_path, "SELECT count(*) FROM jobs") == [(1,)]
    refused(as_runner(c, token, "0" * 64, f"/api/runner/jobs/{jid}/events", [ev(jid, 2)]), 403, "bad_claim_token")
    assert as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", [ev(jid, 2, "chapters", "done")]).status_code == 200
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "running"  # its own runner came back
    assert result(c, token, ct, jid, "stopped", "stopped").json()["state"] == "stopped"
    assert ask(c, client_id="b").status_code == 202  # an ended job frees the slot


# ---- admission ----

@pytest.mark.parametrize("config", [None, {"enabled": False}])
def test_disabled_without_config(db_path, seeded, tmp_path, config):
    cfg = config and write_config(tmp_path, **config)[0]
    nobody = "0" * 32
    with TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL) as c:
        for r in (c.get("/api/catalog"), ask(c), c.get(f"/api/jobs/{nobody}"), claim(c, "x" * 32), avail(c, "x" * 32),
                  readback(c, "x" * 32, None, nobody), as_runner(c, "x" * 32, None, f"/api/runner/jobs/{nobody}/events", [])):
            refused(r, 503, "disabled")
        assert c.get("/api/health").json() == {"ok": True, "editions": 1}  # everything else as before
        assert c.get("/api/reports").status_code == 200 and c.get(f"/reports/{seeded}").status_code == 200


def test_catalog_shows_public_fields_only(jobs_app):
    c, _ = jobs_app()
    r = c.get("/api/catalog")
    assert r.json() == [{"filing_id": FILING_ID, "issuer": "Palantir Technologies Inc.", "form": "10-K",
                         "period": "FY2025", "language": "en"}]
    assert str(FILING.parent) not in r.text and str(CHECKER.parent) not in r.text


def test_refusals_admit_nothing(jobs_app, db_path):
    c, token = jobs_app()
    refused(ask(c, access_code="wrong"), 403, "bad_access_code")
    refused(ask(c, access_code=""), 403, "bad_access_code")
    refused(ask(c, access_code=ACCESS[:-1]), 403, "bad_access_code")
    refused(ask(c, filing_id="msft-fy2025-10k"), 422, "unknown_filing")
    refused(ask(c, language="ko"), 422, "unknown_filing")
    assert claim(c, token).status_code == 204  # nothing to claim: zero runs possible
    first = ask(c, client_id="browser-a")
    assert first.status_code == 202 and first.json()["state"] == "requested"
    refused(ask(c, client_id="browser-a"), 429, "rate_limited")  # one active job per browser
    refused(ask(c, client_id="browser-b"), 503, "busy")  # max_active 1
    assert claim(c, token).json()["job_id"] == first.json()["job_id"]
    assert claim(c, token).status_code == 204  # the refused requests left nothing behind
    assert sql(db_path, "SELECT count(*) FROM jobs") == [(1,)]  # refusals store no job


def test_admission_needs_a_fresh_available_report(jobs_app, db_path):
    """Without a fresh `available` report from the runner, admission refuses and stores no job."""
    c, token = jobs_app(available=False, availability_ttl_seconds=120)
    refused(ask(c), 503, "unavailable")  # no report yet
    for state, code in [("disabled", "unavailable"), ("cap_reached", "cap_reached")]:
        assert avail(c, token, state, code).json() == {"state": state, "ttl_seconds": 120}
        refused(ask(c), 503, code)
    assert avail(c, token).status_code == 200
    sql(db_path, "UPDATE runner_availability SET reported_at = ?", jobs.ago(seconds=121))
    refused(ask(c), 503, "unavailable")  # stale
    sql(db_path, "UPDATE runner_availability SET reported_at = ?", jobs.ago(seconds=100))
    assert sql(db_path, "SELECT count(*) FROM jobs") == [(0,)]
    assert ask(c).status_code == 202
    assert avail(c, token, "busy").status_code == 422
    assert avail(c, token, "available", "free text").status_code == 422  # reason codes from the allowlist only
    assert c.post("/api/runner/availability", json={"state": "available"}).status_code == 401


def test_caps(jobs_app, db_path):
    c, token = jobs_app(max_active=5, max_jobs_per_day=2, max_jobs_total=3, claim_timeout_minutes=3000)
    assert [ask(c, client_id=b).status_code for b in ("a", "b")] == [202, 202]
    refused(ask(c, client_id="c"), 503, "cap_reached")  # per day
    sql(db_path, "UPDATE jobs SET created_at = ?", jobs.ago(24 * 60 + 5))  # yesterday's jobs leave the day cap
    assert ask(c, client_id="c").status_code == 202
    refused(ask(c, client_id="d"), 503, "cap_reached")  # total
    assert len({claim(c, token).json()["job_id"] for _ in range(3)}) == 3
    assert claim(c, token).status_code == 204


def test_request_ids_belong_to_their_browser(jobs_app, db_path):
    """client_id is required and client_request_id is unique per client_id."""
    c, token = jobs_app(max_active=3)
    one, two = ask(c, request_id="req-1"), ask(c, request_id="req-1")
    assert one.status_code == two.status_code == 202 and one.json() == two.json()
    for over in ({"filing_id": "msft-fy2025-10k"}, {"language": "ko"}):
        refused(ask(c, request_id="req-1", **over), 409, "conflict")
    other = ask(c, client_id="browser-z", request_id="req-1")  # another browser's key, not a conflict
    assert other.status_code == 202 and other.json()["job_id"] != one.json()["job_id"]
    jid = one.json()["job_id"]
    assert claim(c, token).json()["job_id"] == jid
    assert ask(c, request_id="req-1").json() == {"job_id": jid, "state": "claimed"}  # a replay, not rate_limited
    assert ask(c, client_id="", request_id="req-2").status_code == 422
    body = {"filing_id": FILING_ID, "language": "en", "client_request_id": "req-3", "access_code": ACCESS}
    assert c.post("/api/jobs", json=body).status_code == 422
    assert sql(db_path, "SELECT count(*) FROM jobs") == [(2,)]


def test_unclaimed_job_ends_not_started(jobs_app, db_path):
    """A job not claimed within claim_timeout_minutes ends refused (not_started) and holds nothing."""
    c, token = jobs_app(claim_timeout_minutes=10)
    jid = ask(c, client_id="a").json()["job_id"]
    sql(db_path, "UPDATE jobs SET created_at = ? WHERE job_id = ?", jobs.ago(9), jid)
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "requested"
    sql(db_path, "UPDATE jobs SET created_at = ? WHERE job_id = ?", jobs.ago(11), jid)
    job = c.get(f"/api/jobs/{jid}").json()
    assert job["state"] == "refused" and job["error"] == {"code": "not_started", "count": 0} and job["ended_at"]
    assert claim(c, token).status_code == 204
    j2 = ask(c, client_id="a").json()["job_id"]  # neither the browser nor the slot is held
    sql(db_path, "UPDATE jobs SET created_at = ? WHERE job_id = ?", jobs.ago(11), j2)
    assert ask(c, client_id="b").status_code == 202  # admission ends the expired job first
    assert sql(db_path, "SELECT state FROM jobs WHERE job_id = ?", j2) == [("refused",)]


def test_job_whose_filing_left_the_catalog_is_never_handed_out(db_path, tmp_path):
    """After a restart without the job's filing, the waiting job ends refused (not_in_catalog)."""
    cfg, token = write_config(tmp_path)
    c = TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL)
    avail(c, token)
    jid = ask(c).json()["job_id"]
    cfg, token = write_config(tmp_path, catalog=[PLTR | {"filing_id": "another-filing"}])
    c = TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL)
    assert claim(c, token).status_code == 204
    job = c.get(f"/api/jobs/{jid}").json()
    assert job["state"] == "refused" and job["error"] == {"code": "not_in_catalog", "count": 0}


# ---- claims ----

@contextlib.contextmanager
def live(app):
    """The app on a real 127.0.0.1 socket (uvicorn in a thread)."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", ws="none"))
    t = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    t.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started
    try:
        yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        server.should_exit = True
        t.join(10)
        sock.close()


def http(method, url, body=None, headers=None):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, (json.loads(r.read()) if r.status != 204 else None)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_claim_is_exclusive(db_path, tmp_path):
    """Twelve runners claim three jobs at the same instant over HTTP: each job has exactly one claimant."""
    cfg, token = write_config(tmp_path, max_active=5)
    with live(create_app(db_path, UI, jobs_config=cfg)) as base:
        assert http("POST", base + "/api/runner/availability", {"state": "available"}, auth(token))[0] == 200
        asked = {http("POST", base + "/api/jobs", {"filing_id": FILING_ID, "language": "en", "access_code": ACCESS,
                                                   "client_request_id": f"r{i}", "client_id": f"b{i}"})[1]["job_id"]
                 for i in range(3)}
        barrier, got = threading.Barrier(12), []

        def go(i):
            barrier.wait()
            got.append(http("POST", base + "/api/runner/claim",
                            {"runner_id": f"runner-{i}", "claim_request_id": f"claim-request-{i:04d}"}, auth(token)))
        threads = [threading.Thread(target=go, args=(i,)) for i in range(12)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
    claimed = [b["job_id"] for s, b in got if s == 200]
    assert sorted(s for s, _ in got) == [200] * 3 + [204] * 9 and set(claimed) == asked and len(claimed) == 3
    rows = sql(db_path, "SELECT state, runner_id, claim_token_sha256 FROM jobs")
    assert [s for s, _, _ in rows] == ["claimed"] * 3 and len({r for _, r, _ in rows}) == 3
    assert {store.sha256(b["claim_token"].encode()) for s, b in got if s == 200} == {h for _, _, h in rows}


def test_repeated_claim_is_a_readback(jobs_app, db_path):
    """The same claim_request_id returns the same job and token (never a second claim); another runner_id under
    it is a conflict."""
    c, token = jobs_app(max_active=2)
    j1, j2 = ask(c, client_id="a").json()["job_id"], ask(c, client_id="b").json()["job_id"]
    first = claim(c, token, crid="claim-request-0001")
    assert first.json()["job_id"] == j1 and claim(c, token, crid="claim-request-0001").json() == first.json()
    refused(claim(c, token, "runner-2", crid="claim-request-0001"), 409, "conflict")
    assert sql(db_path, "SELECT job_id FROM jobs WHERE state = 'requested'") == [(j2,)]  # untouched
    ct = first.json()["claim_token"]
    as_runner(c, token, ct, f"/api/runner/jobs/{j1}/events", [ev(j1, 1)])
    again = claim(c, token, crid="claim-request-0001").json()
    assert again == first.json() | {"state": "running"}  # after a lost answer: same token, current state
    assert claim(c, token, crid="claim-request-0002").json()["job_id"] == j2  # a new key claims the next job
    assert claim(c, token, crid="too-short").status_code == 422


@pytest.mark.parametrize("auth_header", [None, "Bearer wrong", "Bearer {t}x", "Bearer {short}", "Basic {t}", "{t}", "Bearer"])
def test_runner_needs_its_token(jobs_app, auth_header):
    c, token = jobs_app()
    jid = ask(c).json()["job_id"]
    headers = {"authorization": auth_header.format(t=token, short=token[:-1])} if auth_header else {}
    for path, body in [("/api/runner/availability", {"state": "disabled"}),
                       ("/api/runner/claim", {"runner_id": "runner-1", "claim_request_id": "claim-request-0001"}),
                       (f"/api/runner/jobs/{jid}/events", [ev(jid, 1)]),
                       (f"/api/runner/jobs/{jid}/delivery", {"operation_id": "op-1", "files": {}}),
                       (f"/api/runner/jobs/{jid}/result", {"operation_id": "op-2", "outcome": "failed", "reason": "stopped"}),
                       (f"/api/runner/jobs/{jid}", None)]:
        r = c.post(path, json=body, headers=headers) if body is not None else c.get(path, headers=headers)
        refused(r, 401, "unauthorized")
        assert r.headers["www-authenticate"] == "Bearer" and token not in r.text
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "requested"  # nothing happened
    assert ask(c, client_id="b").status_code == 503  # still available (the disabled report was refused) and busy
    assert claim(c, token).status_code == 200


# ---- events ----

def test_events_carry_a_sequence(jobs_app):
    c, token = jobs_app()
    jid, ct = started(c, token)

    def post(lines):
        return as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", lines)
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "claimed"
    r = post([ev(jid, 1, "start", "started", note="hello"), ev(jid, 2, spend_usd=0.12, extra="dropped")])
    assert r.json() == {"job_id": jid, "state": "running", "last_seq": 2}
    r = post([ev(jid, 2, spend_usd=0.12), ev(jid, 3, "chapters", "done", spend_usd=0.31)])  # 2 again: ignored
    assert r.json()["last_seq"] == 3
    refused(post([ev(jid, 3, "chapters", "failed")]), 409, "seq_conflict")  # another line under a used seq
    refused(post([ev(jid, 5)]), 409, "seq_gap")
    refused(post([ev(jid, 4), ev(jid, 4, note="other")]), 409, "seq_conflict")  # the whole batch is refused
    lines = [ev(jid, 1, "start", "started", note="hello"), ev(jid, 2, spend_usd=0.12),
             ev(jid, 3, "chapters", "done", spend_usd=0.31)]
    job = c.get(f"/api/jobs/{jid}").json()
    assert job["state"] == "running" and job["spend_usd"] == 0.31 and job["last_seq"] == 3 and job["events"] == lines
    assert c.get(f"/api/jobs/{jid}", params={"after": 2}).json()["events"] == lines[2:]  # only newer lines
    assert c.get(f"/api/jobs/{jid}", params={"after": 3}).json()["events"] == []
    assert c.get(f"/api/jobs/{jid}", params={"after": -1}).status_code == 422
    assert not {"client_id", "client_request_id", "runner_id", "access_code", "claim_request_id",
                "claim_token_sha256", "claim_token"} & set(job)
    for bad in (ev(jid, 4, stage="Chapters"), ev(jid, 4, stage="two words"), ev(jid, 4, note="x" * 201), ev(jid, 0),
                ev(jid, jobs.MAX_EVENTS + 1), ev(jid, 4, status="DONE!"), ev(jid, 4, spend_usd=-1)):
        assert post([bad]).status_code == 422, bad
    assert post([ev(jid, 4, note="x" * 200)]).status_code == 200
    refused(post([ev("f" * 32, 5)]), 422, "bad_event")
    assert post([]).status_code == 422
    refused(as_runner(c, token, ct, f"/api/runner/jobs/{'f' * 32}/events", [ev("f" * 32, 1)]), 404, "not_found")
    refused(c.get(f"/api/jobs/{'f' * 32}"), 404, "not_found")
    assert c.get("/api/jobs/not-a-job-id").status_code == 422
    assert readback(c, token, ct, jid).json()["last_seq"] == 4


# ---- deliveries and results ----

def test_r14_delivery_is_ready(jobs_app, tmp_path):
    c, token = jobs_app()
    jid, ct = started(c, token)
    r = deliver(c, token, ct, jid)
    job = r.json()
    assert r.status_code == 200 and job["state"] == "ready" and job["error"] is None and job["ended_at"]
    assert job["edition_status"] == R14_STATUS and job["spend_usd"] is None  # no spend was observed
    (ed,) = c.get("/api/reports").json()
    assert ed["id"] == job["edition_id"] and ed["review_findings"]["count"] == 23
    page = c.get(f"/reports/{job['edition_id']}")
    assert page.status_code == 200 and 'id="report-data"' in page.text and "Not an accepted report" in page.text
    assert sorted(p.name for p in (tmp_path / "jobs" / jid / "delivery").iterdir()) == sorted(NAMES)
    for path, body in [("events", [ev(jid, 1)]), ("delivery", {"operation_id": "op-other", "files": files_of()}),
                       ("result", {"operation_id": "op-r", "outcome": "failed", "reason": "engine_error"})]:
        refused(as_runner(c, token, ct, f"/api/runner/jobs/{jid}/{path}", body), 409, "not_open")  # it has ended
    public = c.get(f"/api/jobs/{jid}").json()
    assert public.pop("events") == [] and public == job


def test_same_report_twice_reuses_its_edition(jobs_app):
    c, token = jobs_app()
    eids = []
    for b in ("a", "b"):
        jid, ct = started(c, token, client_id=b)
        eids.append(deliver(c, token, ct, jid).json()["edition_id"])
    assert eids[0] == eids[1] and len(c.get("/api/reports").json()) == 1


def test_status_sidecar_must_name_the_report(jobs_app, db_path):
    """EDITION-STATUS.json names the report's sha256, checked on the dedup path too."""
    c, token = jobs_app(max_active=3)
    side = json.loads(base64.b64decode(files_of()["EDITION-STATUS.json"])) | {"report_sha256": "0" * 64}
    bad = files_of() | {"EDITION-STATUS.json": base64.b64encode(json.dumps(side).encode()).decode()}
    for client_id, files, state in [("a", bad, "failed"), ("b", None, "ready"), ("c", bad, "failed")]:
        jid, ct = started(c, token, client_id=client_id)
        job = deliver(c, token, ct, jid, files).json()
        assert job["state"] == state
        if state == "failed":
            assert job["error"]["code"] == "integrity_error" and "status sidecar is for report" in job["error"]["errors"][0]
    assert sql(db_path, "SELECT count(*) FROM editions") == [(1,)]


@pytest.mark.parametrize("tamper, message", [
    ("manifest", "REPORT.json sha256"),
    ("token", "section ~cover/summary-thesis: unknown fact revenue-fy2o25"),
    ("schema", "KeyError")])
def test_integrity_error_fails_with_no_edition(jobs_app, db_path, tmp_path, tamper, message):
    c, token = jobs_app()
    jid, ct = started(c, token)
    if tamper == "manifest":  # a manifest hash that does not match the report
        files = files_of()
        m = json.loads(base64.b64decode(files["DELIVERY-MANIFEST.json"])) | {"report_sha256": "0" * 64}
        files["DELIVERY-MANIFEST.json"] = base64.b64encode(json.dumps(m).encode()).decode()
    elif tamper == "token":  # hashes agree, but one fact token does not resolve (the checker)
        files = files_of(copy_delivery(tmp_path, lambda t: t.replace("{fact:revenue-fy2025}", "{fact:revenue-fy2o25}", 1)))
    else:  # hashes agree and the report names the job's filing, but it is not a ReportDocument (the adapter)
        files = files_of(copy_delivery(tmp_path, lambda t: json.dumps(
            {"version": 2, "language": "en", "filing": {"accession": PLTR["accession"]}})))
    job = deliver(c, token, ct, jid, files).json()  # the runner's response carries the details
    assert job["state"] == "failed" and job["edition_id"] is None and job["edition_status"] is None
    assert job["error"]["code"] == "integrity_error" and message in job["error"]["errors"][0]
    assert job["error"]["count"] == len(job["error"]["errors"]) >= 1
    public = c.get(f"/api/jobs/{jid}").json()  # the public view shows the code and the count only
    assert public["error"] == {"code": "integrity_error", "count": job["error"]["count"]}
    assert c.get("/api/reports").json() == [] and sql(db_path, "SELECT count(*) FROM editions") == [(0,)]


def test_bad_delivery_requests_leave_the_job_open(jobs_app):
    c, token = jobs_app()
    jid, ct = started(c, token)
    files = files_of()
    for bad in ({k: v for k, v in files.items() if k != "REPORT.json"}, files | {"../x.json": "e30="},
                files | {"REPORT.json": "not base64!"}):
        refused(deliver(c, token, ct, jid, bad), 422, "bad_delivery")
    assert as_runner(c, token, ct, f"/api/runner/jobs/{jid}/delivery", {"files": files}).status_code == 422  # no id
    refused(deliver(c, token, None, jid), 403, "bad_claim_token")
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "claimed"
    assert readback(c, token, ct, jid).json()["operations"] == []
    assert deliver(c, token, ct, jid).json()["state"] == "ready"


def test_operation_ids_make_retries_safe(jobs_app, db_path):
    """A repeated operation returns its original response; another request under a used id is a conflict."""
    c, token = jobs_app(max_active=2)
    jid, ct = started(c, token, client_id="a")
    first = deliver(c, token, ct, jid, op="op-d1")
    assert first.status_code == 200 and first.json()["state"] == "ready"
    assert deliver(c, token, ct, jid, op="op-d1").json() == first.json()
    no_sidecar = {k: v for k, v in files_of().items() if k != "EDITION-STATUS.json"}
    refused(deliver(c, token, ct, jid, no_sidecar, op="op-d1"), 409, "operation_conflict")
    refused(result(c, token, ct, jid, op="op-d1"), 409, "operation_conflict")  # a result under a delivery's id
    back = readback(c, token, ct, jid).json()
    assert back["state"] == "ready" and back["last_seq"] == 0 and back["error"] is None
    assert back["operations"] == [{"operation_id": "op-d1", "kind": "delivery", "completed": True}]
    j2, ct2 = started(c, token, client_id="b")
    ended = result(c, token, ct2, j2, "failed", "timeout", op="op-r1")
    assert ended.json()["state"] == "failed" and result(c, token, ct2, j2, "failed", "timeout", op="op-r1").json() == ended.json()
    refused(result(c, token, ct2, j2, "failed", "engine_error", op="op-r1"), 409, "operation_conflict")
    refused(result(c, token, ct2, j2, "failed", "timeout", op="op-r2"), 409, "not_open")
    assert deliver(c, token, ct2, j2, op="op-d1").status_code == 409  # ids are per job: a new delivery on an ended job
    assert sql(db_path, "SELECT count(*) FROM editions") == [(1,)]


def test_delivery_cut_after_ingest_is_completed_by_its_repeat(jobs_app, db_path, monkeypatch):
    """When the edition was stored but the job update was not (the process died in between), the job stays
    ingesting and a repeat of the same operation completes it with that edition."""
    c, token = jobs_app()
    jid, ct = started(c, token)
    real, entered = jobs.transaction, []

    @contextlib.contextmanager
    def cut(conn):
        entered.append(1)
        if len(entered) == 2:  # the job update after the ingest commit
            raise RuntimeError("cut")
        with real(conn):
            yield conn
    monkeypatch.setattr(jobs, "transaction", cut)
    with pytest.raises(RuntimeError, match="cut"):
        deliver(c, token, ct, jid, op="op-cut")
    monkeypatch.setattr(jobs, "transaction", real)
    assert sql(db_path, "SELECT count(*) FROM editions") == [(1,)]
    back = readback(c, token, ct, jid).json()
    assert back["state"] == "ingesting" and back["edition_id"] is None
    assert back["operations"] == [{"operation_id": "op-cut", "kind": "delivery", "completed": False}]
    refused(deliver(c, token, ct, jid, op="op-other"), 409, "not_open")
    refused(result(c, token, ct, jid), 409, "not_open")
    job = deliver(c, token, ct, jid, op="op-cut").json()
    assert job["state"] == "ready" and job["edition_id"] == sql(db_path, "SELECT id FROM editions")[0][0]
    assert deliver(c, token, ct, jid, op="op-cut").json() == job
    assert sql(db_path, "SELECT count(*) FROM editions") == [(1,)]


@pytest.mark.parametrize("outcome", ["failed", "stopped", "refused"])
def test_result_ends_the_job(jobs_app, outcome):
    c, token = jobs_app()
    jid, ct = started(c, token)
    job = result(c, token, ct, jid, outcome, "provider_error", spend_usd=0.05).json()
    assert job["state"] == outcome and job["error"] == {"code": "provider_error", "count": 0, "errors": []}
    assert job["spend_usd"] == 0.05 and job["edition_id"] is None and job["ended_at"]
    assert c.get(f"/api/jobs/{jid}").json()["error"] == {"code": "provider_error", "count": 0}
    refused(result(c, token, ct, jid, op="op-result-2"), 409, "not_open")
    refused(as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", [ev(jid, 1)]), 409, "not_open")
    for bad in ({"outcome": "done"}, {"outcome": "ready"}, {"reason": "engine stopped"}, {"reason": "spoofed"}):
        assert result(c, token, ct, jid, **({"op": "op-bad"} | bad)).status_code == 422, bad
    assert ask(c, access_code=f" {ACCESS}\n").status_code == 202  # an ended job frees the browser and the slot


def test_spend_stays_null_until_observed(jobs_app):
    c, token = jobs_app()
    jid, ct = started(c, token)
    as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", [ev(jid, 1)])
    assert c.get(f"/api/jobs/{jid}").json()["spend_usd"] is None
    assert result(c, token, ct, jid, "stopped", "stopped").json()["spend_usd"] is None


def test_result_needs_a_claim(jobs_app):
    c, token = jobs_app()
    jid = ask(c).json()["job_id"]
    refused(result(c, token, "0" * 64, jid), 403, "bad_claim_token")
    refused(result(c, token, None, jid), 403, "bad_claim_token")


def test_operator_ends_an_unknown_job(jobs_app, db_path, tmp_path, capsys):
    """The local operator command ends an unknown job (failed, operator_closed); nothing else."""
    c, token = jobs_app()
    jid, ct = started(c, token, client_id="a")
    db = ["--db", str(db_path)]
    end = [*db, "end", jid, "--reason", "operator_closed"]
    assert jobs_admin.main(end) == 1  # claimed and live, not unknown
    sql(db_path, "UPDATE jobs SET seen_at = ? WHERE job_id = ?", jobs.ago(21), jid)
    assert jobs_admin.main([*db, "list"]) == 0 and f"{jid} unknown" in capsys.readouterr().out
    refused(ask(c, client_id="b"), 503, "busy")
    assert jobs_admin.main(end) == 0
    job = c.get(f"/api/jobs/{jid}").json()
    assert job["state"] == "failed" and job["error"] == {"code": "operator_closed", "count": 0} and job["ended_at"]
    assert ask(c, client_id="b").status_code == 202  # the slot is free
    refused(result(c, token, ct, jid), 409, "not_open")  # its runner cannot reopen it
    assert jobs_admin.main(end) == 1 and jobs_admin.main([*db, "end", "f" * 32, "--reason", "operator_closed"]) == 1
    with pytest.raises(SystemExit):
        jobs_admin.main([*db, "end", jid, "--reason", "because"])
    assert jobs_admin.main(["--db", str(tmp_path / "none.db"), "list"]) == 1 and not (tmp_path / "none.db").exists()


def test_catalog_change_across_a_restart_fails_the_job(db_path, tmp_path):
    cfg, token = write_config(tmp_path)
    c = TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL)
    avail(c, token)
    ask(c)
    got = claim(c, token, crid="claim-before-restart").json()
    cfg, token = write_config(tmp_path, catalog=[PLTR | {"filing_id": "another-filing"}])  # a new catalog and token
    c = TestClient(create_app(db_path, UI, jobs_config=cfg), base_url=LOCAL)
    refused(claim(c, token, crid="claim-before-restart"), 409, "conflict")  # the token changed: no readback
    job = deliver(c, token, got["claim_token"], got["job_id"]).json()  # the claim token still holds
    assert job["state"] == "failed" and job["error"]["code"] == "not_in_catalog" and job["edition_id"] is None


# ---- limits ----

def test_delivery_limit_is_4_mib_decoded_and_needs_the_token(jobs_app):
    c, token = jobs_app()
    jid, ct = started(c, token)

    def two_files(n):
        return {name: base64.b64encode(b"x" * n).decode() for name in ("REPORT.json", "DELIVERY-MANIFEST.json")}
    refused(deliver(c, token, ct, jid, two_files(jobs.MAX_DECODED // 2 + 1)), 413, "too_large")
    over = {"operation_id": "op-1", "files": {"REPORT.json": "A" * jobs.MAX_DELIVERY_BODY}}
    assert as_runner(c, token, ct, f"/api/runner/jobs/{jid}/delivery", over).status_code == 413  # refused unread
    r = c.post(f"/api/runner/jobs/{jid}/delivery", json={"operation_id": "op-1", "files": files_of()},
               headers={"x-claim-token": ct})  # about 170 KB, no runner token: the 64 KB limit applies
    assert r.status_code == 413 and len(json.dumps(files_of())) > 64 * 1024
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "claimed"
    job = deliver(c, token, ct, jid, two_files(jobs.MAX_DECODED // 2)).json()  # at the limit: read, then refused
    assert job["state"] == "failed" and job["error"]["code"] == "integrity_error"


def test_other_routes_keep_the_64_kb_limit(jobs_app, seeded):
    c, token = jobs_app()
    jid, ct = started(c, token)
    pad = "x" * (65 * 1024)
    assert ask(c, client_id="b", pad=pad).status_code == 413
    assert c.post("/api/runner/availability", json={"state": "available", "pad": pad}, headers=auth(token)).status_code == 413
    assert claim(c, token, crid="claim-request-pad").status_code == 204
    assert c.post("/api/runner/claim", json={"runner_id": "r", "claim_request_id": "claim-request-pad", "pad": pad},
                  headers=auth(token)).status_code == 413
    assert as_runner(c, token, ct, f"/api/runner/jobs/{jid}/events", [ev(jid, 1, note=pad)]).status_code == 413
    assert result(c, token, ct, jid, pad=pad).status_code == 413
    assert c.post(f"/api/editions/{seeded}/overlays", json={"kind": "memo", "body": {"t": pad}},
                  headers=auth(token)).status_code == 413
    assert c.get(f"/api/jobs/{jid}").json()["state"] == "claimed"


def test_validation_errors_never_echo_the_access_code(jobs_app):
    c, _ = jobs_app()
    r = c.post("/api/jobs", json={"access_code": ACCESS, "filing_id": FILING_ID})
    assert r.status_code == 422 and ACCESS not in r.text and "client_id" in r.text


@pytest.mark.parametrize("over, match", [
    ({"surprise": 1}, "unknown keys"), ({"enabled": "yes"}, "enabled"), ({"max_jobs_total": None}, "max_jobs_total"),
    ({"max_active": 0}, "max_active"), ({"claim_timeout_minutes": 0}, "claim_timeout_minutes"),
    ({"availability_ttl_seconds": "120"}, "availability_ttl_seconds"), ({"catalog": []}, "catalog"),
    ({"jobs_dir": ""}, "jobs_dir"), ({"catalog": [{"filing_id": "PLTR"}]}, "catalog entry"),
    ({"catalog": [{k: v for k, v in PLTR.items() if k != "accession"}]}, "catalog entry")])
def test_bad_config_stops_the_start(db_path, tmp_path, over, match):
    cfg, token = write_config(tmp_path, **over)
    with pytest.raises(jobs.ConfigError, match=match) as e:
        create_app(db_path, UI, jobs_config=cfg)
    assert token not in str(e.value)


@pytest.mark.parametrize("name, value, least", [("runner.token", "short-token", 16), ("access.code", "a" * 19, 20)])
def test_short_secret_stops_the_start(db_path, tmp_path, name, value, least):
    cfg, _ = write_config(tmp_path)
    (tmp_path / name).write_text(value + "\n")
    with pytest.raises(jobs.ConfigError, match=f"shorter than {least}") as e:
        create_app(db_path, UI, jobs_config=cfg)
    assert value not in str(e.value)


def test_config_must_be_an_object(db_path, tmp_path):
    (tmp_path / "jobs.json").write_text("[]")
    with pytest.raises(jobs.ConfigError, match="JSON object"):
        create_app(db_path, UI, jobs_config=tmp_path / "jobs.json")


# ---- the fake runner ----

def test_end_to_end_with_the_fake_runner(db_path, tmp_path, capsys):
    """A judge asks over HTTP; the fake runner CLI reports itself available, claims, reports progress and delivers
    R14; the edition opens."""
    cfg, token = write_config(tmp_path)
    runner = ["--token-file", str(tmp_path / "runner.token"), "--delay", "0"]
    body = {"filing_id": FILING_ID, "language": "en", "client_request_id": "e2e-1", "client_id": "judge-browser",
            "access_code": ACCESS}
    with live(create_app(db_path, UI, jobs_config=cfg)) as base:
        assert http("GET", base + "/api/catalog")[1][0]["filing_id"] == FILING_ID
        assert http("POST", base + "/api/jobs", body)[1]["code"] == "unavailable"  # no runner has reported yet
        done = []
        t = threading.Thread(target=lambda: done.append(fake_runner.main(["--app", base, *runner, "--wait", "30"])))
        t.start()
        deadline = time.monotonic() + 20
        while (r := http("POST", base + "/api/jobs", body))[0] != 202 and time.monotonic() < deadline:
            time.sleep(0.1)  # admitted once the runner's availability report has arrived
        t.join(60)
        status, asked = r
        assert status == 202 and done == [0]
        job = http("GET", f"{base}/api/jobs/{asked['job_id']}")[1]
        assert job["state"] == "ready" and job["spend_usd"] is None and job["edition_status"] == R14_STATUS
        assert [(e["seq"], e["stage"]) for e in job["events"]] == [(i, s) for i, (s, _, _) in enumerate(fake_runner.STAGES, 1)]
        with urllib.request.urlopen(f"{base}/reports/{job['edition_id']}", timeout=60) as page:
            assert page.status == 200 and 'id="report-data"' in page.read().decode()
        assert fake_runner.main(["--app", base, *runner]) == 0  # nothing waiting
        assert fake_runner.main(["--app", base, *runner, "--state", "cap_reached"]) == 0
        assert http("POST", base + "/api/jobs", body | {"client_request_id": "e2e-2"})[1]["code"] == "cap_reached"
    out = capsys.readouterr().out
    assert f"job {asked['job_id']}: ready, edition {job['edition_id']}" in out and "no job waiting" in out
    assert "reported cap_reached" in out
    assert token not in out and not re.search(r"[0-9a-f]{64}", out)  # neither the runner token nor a claim token


@pytest.mark.parametrize("url, ok", [
    ("http://127.0.0.1:8000", True), ("http://localhost:8000", True), ("http://[::1]:8000", True),
    ("http://127.5.5.5", True), ("https://athena.example", True), ("http://athena.example", False),
    ("http://127.0.0.1.example.com", False), ("http://10.0.0.5:8000", False), ("ftp://127.0.0.1", False),
    ("http://", False)])
def test_fake_runner_keeps_the_token_off_plain_http(url, ok, tmp_path):
    """http:// only to a loopback host; refused before any connection."""
    assert fake_runner.url_ok(url) is ok
    if not ok:
        (tmp_path / "t").write_text("x" * 32)
        with pytest.raises(SystemExit):
            fake_runner.main(["--app", url, "--token-file", str(tmp_path / "t")])
        with pytest.raises(ValueError):
            fake_runner.run(url, "x" * 32)
