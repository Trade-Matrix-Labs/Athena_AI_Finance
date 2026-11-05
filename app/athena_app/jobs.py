"""Live report jobs. The runner pulls: it reports its
availability, claims a job (and gets a claim token), posts progress lines with a sequence number, then a delivery
(ingest: `ready` with an edition, or `failed`) or a result; each delivery and result carries an operation id. The
app never calls the runner or a model.

Configuration (--jobs-config / ATHENA_JOBS_CONFIG: a JSON file; relative paths are read from its folder): enabled,
catalog [{filing_id, issuer, form, period, language, accession, filing_path, checker_path}], access_code_file,
runner_token_file, jobs_dir, max_active (1), max_jobs_per_day, max_jobs_total, stale_minutes (20),
claim_timeout_minutes (10), availability_ttl_seconds (120).
Without a file, or with `enabled` not true, every jobs route answers 503 {"code": "disabled"}.
"""
import base64
import binascii
import contextlib
import datetime
import hmac
import json
import pathlib
import re
import secrets
import sqlite3
from typing import Annotated, Literal

from fastapi import Body, Depends, FastAPI, Header, Path, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import store
from .ingest import ValidationRefused, ingest

LIVE = ("claimed", "running", "ingesting")  # on the runner's side; read unknown after stale_minutes without contact
OPEN = ("claimed", "running")  # a claimant may post events, a delivery or a result
ACTIVE_WHERE = " WHERE state IN ('requested', 'claimed', 'running', 'ingesting')"  # an unknown job keeps counting
REASONS = ("cap_reached", "unavailable", "engine_error", "provider_error", "timeout", "input_error", "stopped",
           "operator_closed", "not_started", "not_in_catalog")  # the only reason codes a runner may send
REQUIRED_FILES = {"REPORT.json", "DELIVERY-MANIFEST.json"}
OPTIONAL_FILES = {"EDITION-STATUS.json"}  # the pipeline's edition status sidecar; it names the report's sha256
MAX_DECODED = 4 * 1024 * 1024  # delivered bytes in total, after base64
MAX_DELIVERY_BODY = (MAX_DECODED + 2) // 3 * 4 + 64 * 1024  # request bytes for a delivery: the base64 plus JSON
MAX_EVENTS = 500  # per job
DELIVERY_PATH = re.compile(r"/api/runner/jobs/[^/]+/delivery")
PUBLIC = ("filing_id", "issuer", "form", "period", "language")
INTS = {"max_active": 1, "max_jobs_per_day": None, "max_jobs_total": None, "stale_minutes": 20,
        "claim_timeout_minutes": 10, "availability_ttl_seconds": 120}  # None: required
FILES = ("access_code_file", "runner_token_file", "jobs_dir")

Key = Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{1,128}$")]
Usd = Annotated[float, Field(ge=0, le=1e6, allow_inf_nan=False)]
JobId = Annotated[str, Path(pattern=r"^[0-9a-f]{32}$")]
ClaimToken = Annotated[str | None, Header(max_length=128)]  # X-Claim-Token
Reason = Literal[REASONS]


class JobIn(BaseModel):
    filing_id: Annotated[str, Field(min_length=1, max_length=128)]
    language: Annotated[str, Field(min_length=1, max_length=16)]
    client_request_id: Key
    client_id: Key
    access_code: Annotated[str, Field(max_length=256)]


class ClaimIn(BaseModel):
    runner_id: Key
    claim_request_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9._:-]{16,128}$")]  # also seeds the claim token


class AvailabilityIn(BaseModel):
    state: Literal["available", "disabled", "cap_reached"]
    reason: Reason | None = None


class EventIn(BaseModel):  # one progress line; unknown fields are dropped
    job_id: str
    seq: Annotated[int, Field(ge=1, le=MAX_EVENTS)]
    stage: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]
    status: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,31}$")]
    ts: Annotated[str, Field(min_length=1, max_length=40)]
    note: Annotated[str, Field(max_length=200)] | None = None
    spend_usd: Usd | None = None


class DeliveryIn(BaseModel):
    operation_id: Key
    files: dict[str, str]


class ResultIn(BaseModel):
    operation_id: Key
    outcome: Literal["failed", "stopped", "refused"]
    reason: Reason
    spend_usd: Usd | None = None  # null when not observed


class Refusal(Exception):
    """An answer with a stable code: {"code": ..., "detail": ...}, plus any `extra` fields of the body."""

    def __init__(self, status, code, detail, headers=None, **extra):
        super().__init__(detail)
        self.status, self.code, self.detail, self.headers, self.extra = status, code, detail, headers, extra


class ConfigError(ValueError):
    pass


def secret(path, least):
    value = pathlib.Path(path).read_text().strip()
    if len(value) < least:  # the message never carries the value
        raise ConfigError(f"jobs config: the secret in {pathlib.Path(path).name} is shorter than {least} characters")
    return value.encode()


def load_config(path):
    """The jobs configuration, checked once at start-up. None (jobs disabled) without a file or unless enabled."""
    if not path:
        return None
    path = pathlib.Path(path)
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise ConfigError("jobs config must be a JSON object")
    if extra := set(raw) - {"enabled", "catalog", *INTS, *FILES}:
        raise ConfigError(f"jobs config: unknown keys {sorted(extra)}")
    if type(raw.get("enabled", False)) is not bool:
        raise ConfigError("jobs config: enabled must be true or false")
    if not raw.get("enabled"):
        return None
    here, cfg = path.parent, {}
    for k, default in INTS.items():
        if type(v := raw.get(k, default)) is not int or v < 1:
            raise ConfigError(f"jobs config: {k} must be a whole number of at least 1")
        cfg[k] = v
    for k in FILES:
        if not isinstance(raw.get(k), str) or not raw[k]:
            raise ConfigError(f"jobs config: {k} is required")
    cfg["token"] = secret(here / raw["runner_token_file"], 16)
    cfg["access_code"] = secret(here / raw["access_code_file"], 20)  # guessing is infeasible without a throttle
    cfg["jobs_dir"] = here / raw["jobs_dir"]
    cfg["jobs_dir"].mkdir(parents=True, exist_ok=True)
    cfg["catalog"] = {}
    if not isinstance(raw.get("catalog"), list) or not raw["catalog"]:
        raise ConfigError("jobs config: catalog must list at least one filing")
    for e in raw["catalog"]:
        if not isinstance(e, dict) or set(e) != {*PUBLIC, "accession", "filing_path", "checker_path"} \
                or not all(isinstance(v, str) and v for v in e.values()):
            raise ConfigError(f"jobs config: a catalog entry needs exactly {PUBLIC} + accession, filing_path, "
                              "checker_path, as text")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", e["filing_id"]) or e["filing_id"] in cfg["catalog"]:
            raise ConfigError(f"jobs config: filing_id {e['filing_id']!r} must be a unique slug")
        e = e | {k: here / e[k] for k in ("filing_path", "checker_path")}
        if not (e["filing_path"].is_file() and e["checker_path"].is_file()):
            raise ConfigError(f"jobs config: the filing or checker of {e['filing_id']} is not a file")
        cfg["catalog"][e["filing_id"]] = e
    return cfg


def token_ok(cfg, headers):
    """`Authorization: Bearer <runner token>`, compared in constant time."""
    scheme, _, given = headers.get("authorization", "").partition(" ")
    return bool(cfg) and scheme.lower() == "bearer" and hmac.compare_digest(given.strip().encode(), cfg["token"])


def claim_token(cfg, job_id, claim_request_id):
    """Opaque, and the same again for a repeated claim_request_id (so a lost claim answer can be read back). The
    app stores only its sha256; computing it needs the runner token."""
    return hmac.new(cfg["token"], f"athena-claim\0{job_id}\0{claim_request_id}".encode(), "sha256").hexdigest()


def ago(minutes=0, seconds=0):
    delta = datetime.timedelta(minutes=minutes, seconds=seconds)
    return (datetime.datetime.now(datetime.UTC) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def state_of(row, cutoff):
    """The stored state, except that a claimed, running or ingesting job with no runner contact since `cutoff` reads
    as unknown. It keeps counting as active and is never handed out again."""
    return "unknown" if row["state"] in LIVE and row["seen_at"] < cutoff else row["state"]


def failure(code, errors=()):
    errors = list(errors)
    return {"code": code, "count": len(errors), "errors": errors[:100]}


@contextlib.contextmanager
def transaction(conn):
    conn.execute("BEGIN IMMEDIATE")  # the write lock first: checks and writes are one step for every caller
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def binding_error(raw, entry, language):
    """The delivered report must name the job's filing (its accession) and language. Checked on the delivered bytes
    before ingest, so it holds on ingest's dedup path too and a mismatched report is never stored."""
    doc = json.loads(raw)
    filing = doc.get("filing") if isinstance(doc, dict) else None
    if not isinstance(filing, dict) or filing.get("accession") != entry["accession"]:
        return "filing_mismatch"
    if doc.get("language") != language:
        return "language_mismatch"
    return None


def add_routes(app: FastAPI, db, ui_dir, cfg):
    """The judge API and the runner API. `db()` opens a store connection; `cfg` comes from load_config."""

    @app.exception_handler(Refusal)
    async def refused(request: Request, e: Refusal):
        return JSONResponse({"code": e.code, "detail": e.detail, **e.extra}, e.status, headers=e.headers)

    def enabled():
        if not cfg:
            raise Refusal(503, "disabled", "live report jobs are not enabled on this server")

    def runner(request: Request):
        enabled()
        if not token_ok(cfg, request.headers):
            raise Refusal(401, "unauthorized", "a valid runner token is required", {"WWW-Authenticate": "Bearer"})

    judge, runner_only = [Depends(enabled)], [Depends(runner)]

    def stale_cutoff():
        return ago(minutes=cfg["stale_minutes"])

    def job_row(conn, job_id):
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            raise Refusal(404, "not_found", "job not found")
        return row

    def owner(conn, job_id, token):
        """The claim token is the claimant's proof; X-Runner-Id alone is not ownership."""
        row = job_row(conn, job_id)
        if not row["claim_token_sha256"] or not hmac.compare_digest(store.sha256((token or "").encode()),
                                                                     row["claim_token_sha256"]):
            raise Refusal(403, "bad_claim_token", "this job's claim token is required")
        return row

    def unstartable(row):
        """Why a requested job can never start, or None."""
        e = cfg["catalog"].get(row["filing_id"])
        if not e or e["language"] != row["language"]:
            return "not_in_catalog"
        return "not_started" if row["created_at"] < ago(minutes=cfg["claim_timeout_minutes"]) else None

    def end_unstartable(conn, rows=None):
        """Requested jobs that can never start end refused; they stop counting and are never handed out."""
        for r in rows or conn.execute("SELECT * FROM jobs WHERE state = 'requested'").fetchall():
            if code := unstartable(r):
                conn.execute("UPDATE jobs SET state = 'refused', error_json = ?, ended_at = ?"
                             " WHERE job_id = ? AND state = 'requested'", (json.dumps(failure(code)), store.now(),
                                                                          r["job_id"]))

    def view(conn, row, after=0, runner=False):
        """The job for the judge (error code and count only, events after `after`) or for its runner (full error)."""
        ed = row["edition_id"] and store.get_edition(conn, row["edition_id"])
        err = row["error_json"] and json.loads(row["error_json"])
        out = {"job_id": row["job_id"], "filing_id": row["filing_id"], "language": row["language"],
               "state": state_of(row, stale_cutoff()), "created_at": row["created_at"],
               "claimed_at": row["claimed_at"], "last_runner_contact_at": row["seen_at"], "ended_at": row["ended_at"],
               "edition_id": row["edition_id"], "edition_status": ed["status"] if ed else None,
               "error": err if runner or not err else {"code": err["code"], "count": err.get("count", 0)},
               "spend_usd": row["spend_usd"], "last_seq": row["last_seq"]}
        if not runner:
            out["events"] = [json.loads(r[0]) for r in conn.execute(
                "SELECT line_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq", (row["job_id"], after))]
        return out

    def operation(conn, job_id, operation_id, kind, request_sha):
        """The stored operation for this id, or None. Another request under a used id is a conflict."""
        op = conn.execute("SELECT * FROM job_operations WHERE job_id = ? AND operation_id = ?",
                          (job_id, operation_id)).fetchone()
        if op and (op["kind"], op["request_sha256"]) != (kind, request_sha):
            raise Refusal(409, "operation_conflict", "this operation_id was used with another request")
        return op

    # ---- judge API (public; the access code admits a request) ----

    @app.get("/api/catalog", dependencies=judge)
    def catalog():
        return [{k: e[k] for k in PUBLIC} for e in cfg["catalog"].values()]

    @app.post("/api/jobs", status_code=202, dependencies=judge)
    def request_job(j: JobIn):
        if not hmac.compare_digest(j.access_code.strip(" \t\r\n").encode(), cfg["access_code"]):
            raise Refusal(403, "bad_access_code", "the access code is not right")
        fingerprint = store.sha256(json.dumps([j.filing_id, j.language]).encode())
        with contextlib.closing(db()) as conn, transaction(conn):
            end_unstartable(conn)
            old = conn.execute("SELECT * FROM jobs WHERE client_id = ? AND client_request_id = ?",
                               (j.client_id, j.client_request_id)).fetchone()
            if old:  # a request id is this browser's own
                if old["input_sha256"] != fingerprint:
                    raise Refusal(409, "conflict", "this client_request_id was used with other inputs")
                return {"job_id": old["job_id"], "state": state_of(old, stale_cutoff())}
            entry = cfg["catalog"].get(j.filing_id)
            if not entry or entry["language"] != j.language:
                raise Refusal(422, "unknown_filing", "this filing and language are not in the catalog")
            av = conn.execute("SELECT state, reported_at FROM runner_availability WHERE id = 1").fetchone()
            if not av or av["state"] == "disabled" or av["reported_at"] < ago(seconds=cfg["availability_ttl_seconds"]):
                raise Refusal(503, "unavailable", "the report service is not available now; try again later")
            if av["state"] == "cap_reached":
                raise Refusal(503, "cap_reached", "the report service has reached its limit")

            def count(where="", *args):
                return conn.execute("SELECT count(*) FROM jobs" + where, args).fetchone()[0]
            if count() >= cfg["max_jobs_total"] \
                    or count(" WHERE created_at >= ?", store.now()[:10] + "T00:00:00Z") >= cfg["max_jobs_per_day"]:
                raise Refusal(503, "cap_reached", "the job limit is reached")
            if count(ACTIVE_WHERE + " AND client_id = ?", j.client_id):
                raise Refusal(429, "rate_limited", "this browser already has an active job")
            if count(ACTIVE_WHERE) >= cfg["max_active"]:
                raise Refusal(503, "busy", "another report is being written; try again later")
            job_id = secrets.token_hex(16)
            conn.execute("INSERT INTO jobs (job_id, client_request_id, input_sha256, client_id, filing_id, language,"
                         " state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)",
                         (job_id, j.client_request_id, fingerprint, j.client_id, j.filing_id, j.language, store.now()))
        return {"job_id": job_id, "state": "requested"}

    @app.get("/api/jobs/{job_id}", dependencies=judge)
    def get_job(job_id: JobId, after: Annotated[int, Query(ge=0, le=MAX_EVENTS)] = 0):
        with contextlib.closing(db()) as conn:
            row = job_row(conn, job_id)
            if row["state"] == "requested" and unstartable(row):
                with transaction(conn):
                    end_unstartable(conn, [row])
                row = job_row(conn, job_id)
            return view(conn, row, after)

    # ---- runner API (bearer token; the claim token for a job's own routes) ----

    @app.post("/api/runner/availability", dependencies=runner_only)
    def availability(a: AvailabilityIn):
        with contextlib.closing(db()) as conn:
            conn.execute("INSERT INTO runner_availability (id, state, reason, reported_at) VALUES (1, ?, ?, ?)"
                         " ON CONFLICT (id) DO UPDATE SET state = excluded.state, reason = excluded.reason,"
                         " reported_at = excluded.reported_at", (a.state, a.reason, store.now()))
        return {"state": a.state, "ttl_seconds": cfg["availability_ttl_seconds"]}

    @app.post("/api/runner/claim", dependencies=runner_only)
    def claim(c: ClaimIn):
        now = store.now()
        with contextlib.closing(db()) as conn, transaction(conn):  # one claimant per job
            old = conn.execute("SELECT * FROM jobs WHERE claim_request_id = ?", (c.claim_request_id,)).fetchone()
            if old:  # a repeat is a read-only reconciliation, never a second claim
                token = claim_token(cfg, old["job_id"], c.claim_request_id)
                if old["runner_id"] != c.runner_id or not hmac.compare_digest(store.sha256(token.encode()),
                                                                              old["claim_token_sha256"]):
                    raise Refusal(409, "conflict", "this claim_request_id belongs to another claim")
                return {"job_id": old["job_id"], "filing_id": old["filing_id"], "language": old["language"],
                        "claim_token": token, "state": state_of(old, stale_cutoff())}
            end_unstartable(conn)
            row = conn.execute("SELECT job_id, filing_id, language FROM jobs WHERE state = 'requested'"
                               " ORDER BY created_at, rowid LIMIT 1").fetchone()
            if row:
                token = claim_token(cfg, row["job_id"], c.claim_request_id)
                conn.execute("UPDATE jobs SET state = 'claimed', runner_id = ?, claim_request_id = ?,"
                             " claim_token_sha256 = ?, claimed_at = ?, seen_at = ? WHERE job_id = ? AND state = 'requested'",
                             (c.runner_id, c.claim_request_id, store.sha256(token.encode()), now, now, row["job_id"]))
        if not row:
            return Response(status_code=204)
        return dict(row) | {"claim_token": token, "state": "claimed"}

    @app.get("/api/runner/jobs/{job_id}", dependencies=runner_only)
    def readback(job_id: JobId, x_claim_token: ClaimToken = None):
        """State, last seq and operations, for readback before any retry."""
        with contextlib.closing(db()) as conn:
            row = owner(conn, job_id, x_claim_token)
            ops = conn.execute("SELECT operation_id, kind, response_json IS NOT NULL FROM job_operations"
                               " WHERE job_id = ? ORDER BY started_at, rowid", (job_id,))
            return view(conn, row, runner=True) | {
                "operations": [{"operation_id": o[0], "kind": o[1], "completed": bool(o[2])} for o in ops]}

    @app.post("/api/runner/jobs/{job_id}/events", dependencies=runner_only)
    def events(job_id: JobId, lines: Annotated[list[EventIn], Body(min_length=1, max_length=100)],
               x_claim_token: ClaimToken = None):
        if any(x.job_id != job_id for x in lines):
            raise Refusal(422, "bad_event", "every event line must carry this job's job_id")
        now = store.now()
        with contextlib.closing(db()) as conn, transaction(conn):
            row = owner(conn, job_id, x_claim_token)
            if row["state"] not in OPEN:
                raise Refusal(409, "not_open", f"this job is {row['state']}")
            last, spend = row["last_seq"], None
            for x in lines:  # an identical repeat is ignored; another line under a used seq is a conflict
                line = json.dumps(x.model_dump(exclude_none=True), sort_keys=True, separators=(",", ":"))
                if x.seq <= last:
                    old = conn.execute("SELECT line_json FROM job_events WHERE job_id = ? AND seq = ?",
                                       (job_id, x.seq)).fetchone()
                    if not old or old[0] != line:
                        raise Refusal(409, "seq_conflict", f"seq {x.seq} was used with another line")
                    continue
                if x.seq != last + 1:
                    raise Refusal(409, "seq_gap", f"the next seq is {last + 1}")
                conn.execute("INSERT INTO job_events VALUES (?, ?, ?, ?)", (job_id, x.seq, line, now))
                last, spend = x.seq, spend if x.spend_usd is None else x.spend_usd
            conn.execute("UPDATE jobs SET state = 'running', seen_at = ?, last_seq = ?, spend_usd = coalesce(?, spend_usd)"
                         " WHERE job_id = ?", (now, last, spend, job_id))
        return {"job_id": job_id, "state": "running", "last_seq": last}

    @app.post("/api/runner/jobs/{job_id}/delivery", dependencies=runner_only)
    def delivery(job_id: JobId, d: DeliveryIn, x_claim_token: ClaimToken = None):
        names = set(d.files)
        if not REQUIRED_FILES <= names or names - REQUIRED_FILES - OPTIONAL_FILES:
            raise Refusal(422, "bad_delivery", f"files: {sorted(REQUIRED_FILES)}, optionally {sorted(OPTIONAL_FILES)}")
        if sum(len(v) * 3 // 4 - v[-2:].count("=") for v in d.files.values()) > MAX_DECODED:  # from the wire size
            raise Refusal(413, "too_large", f"a delivery holds at most {MAX_DECODED} bytes")
        try:
            files = {n: base64.b64decode(v, validate=True) for n, v in d.files.items()}
        except binascii.Error:
            raise Refusal(422, "bad_delivery", "every file must be base64")
        request_sha = store.sha256(json.dumps({n: store.sha256(b) for n, b in files.items()}, sort_keys=True).encode())
        with contextlib.closing(db()) as conn:
            with transaction(conn):
                row = owner(conn, job_id, x_claim_token)
                if op := operation(conn, job_id, d.operation_id, "delivery", request_sha):
                    if op["response_json"]:
                        return json.loads(op["response_json"])  # a repeat returns the original response
                    if row["state"] != "ingesting":
                        raise Refusal(409, "not_open", f"this job is {row['state']}")
                    # the same operation again after a run that did not finish: complete it below
                elif row["state"] not in OPEN:
                    raise Refusal(409, "not_open", f"this job is {row['state']}")
                else:
                    conn.execute("INSERT INTO job_operations (job_id, operation_id, kind, request_sha256, started_at)"
                                 " VALUES (?, ?, 'delivery', ?, ?)", (job_id, d.operation_id, request_sha, store.now()))
                    conn.execute("UPDATE jobs SET state = 'ingesting', seen_at = ? WHERE job_id = ?",
                                 (store.now(), job_id))
            edition_id, error = None, None
            entry = cfg["catalog"].get(row["filing_id"])
            try:
                if not entry or entry["language"] != row["language"]:  # the catalog changed while the job ran
                    error = failure("not_in_catalog")
                elif code := binding_error(files["REPORT.json"], entry, row["language"]):
                    error = failure(code)
                else:
                    folder = cfg["jobs_dir"] / job_id / "delivery"
                    folder.mkdir(parents=True, exist_ok=True)
                    for name, data in files.items():
                        (folder / name).write_bytes(data)
                    edition_id, _ = ingest(conn, folder, ui_dir=ui_dir, checker=entry["checker_path"],
                                           filing=entry["filing_path"])
            except ValidationRefused as e:  # integrity errors: no edition
                error = failure("integrity_error", e.errors)
            except (OSError, sqlite3.Error) as e:  # the app's side; no detail (it may name local paths)
                error = failure("app_error", [type(e).__name__])
            except Exception as e:  # hash mismatch, sidecar, schema, JSON or adapter error in the delivery
                error = failure("integrity_error", [f"{type(e).__name__}: {e}"[:1000]])
            with transaction(conn):
                done = conn.execute("UPDATE jobs SET state = ?, edition_id = ?, error_json = ?, ended_at = ?"
                                    " WHERE job_id = ? AND state = 'ingesting'",
                                    ("failed" if error else "ready", edition_id, error and json.dumps(error),
                                     store.now(), job_id)).rowcount
                if done:
                    response = view(conn, job_row(conn, job_id), runner=True)
                    conn.execute("UPDATE job_operations SET response_json = ?, completed_at = ?"
                                 " WHERE job_id = ? AND operation_id = ?",
                                 (json.dumps(response), store.now(), job_id, d.operation_id))
                    return response
            op = operation(conn, job_id, d.operation_id, "delivery", request_sha)  # completed by a concurrent repeat
            if op and op["response_json"]:
                return json.loads(op["response_json"])
            raise Refusal(409, "not_open", "this job is no longer ingesting")

    @app.post("/api/runner/jobs/{job_id}/result", dependencies=runner_only)
    def result(job_id: JobId, r: ResultIn, x_claim_token: ClaimToken = None):
        request_sha = store.sha256(json.dumps(r.model_dump(exclude={"operation_id"}), sort_keys=True).encode())
        with contextlib.closing(db()) as conn, transaction(conn):
            row = owner(conn, job_id, x_claim_token)
            if op := operation(conn, job_id, r.operation_id, "result", request_sha):
                return json.loads(op["response_json"])  # a repeat returns the original response
            if row["state"] not in OPEN:
                raise Refusal(409, "not_open", f"this job is {row['state']}")
            now = store.now()
            conn.execute("UPDATE jobs SET state = ?, error_json = ?, spend_usd = coalesce(?, spend_usd), ended_at = ?"
                         " WHERE job_id = ?", (r.outcome, json.dumps(failure(r.reason)), r.spend_usd, now, job_id))
            response = view(conn, job_row(conn, job_id), runner=True)
            conn.execute("INSERT INTO job_operations (job_id, operation_id, kind, request_sha256, response_json,"
                         " started_at, completed_at) VALUES (?, ?, 'result', ?, ?, ?, ?)",
                         (job_id, r.operation_id, request_sha, json.dumps(response), now, now))
            return response
