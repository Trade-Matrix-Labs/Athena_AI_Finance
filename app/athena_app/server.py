"""Local FastAPI app: report API, personal overlays and the Desk page.

python -m athena_app.server --db athena.db --ui <desk ui folder> [--port 8000] [--jobs-config <json>] [--ask-config <json>]
"""
import argparse
import functools
import html
import json
import os
import pathlib
import re
import secrets
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import ask, jobs, store
from .adapter import client_view, with_created
from .ingest import chapters
from .validate import load_module

HOSTS = ("127.0.0.1", "localhost")
MAX_BODY = 64 * 1024  # bytes per write request
MAX_DEPTH = 8  # JSON nesting levels per write request, the outer object included
# every response; pages cannot be framed (full script CSP needs the inline script's hash)
SECURITY_HEADERS = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                    "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"}
NOT_FOUND_PAGE = ('<!doctype html><meta charset="utf-8"><title>Athena: not found</title>'
                  '<p>This report was not found. <a href="/">Open the latest report</a>.</p>')
Id = Annotated[int, Path(ge=1, le=2**63 - 1)]  # a SQLite rowid; anything else is a 422, not a 500
# personal overlays belong to a per-browser reader (no account): a random id in an HttpOnly, SameSite=Lax cookie
READER_COOKIE = "athena_reader"
READER_VALUE = re.compile(r"[A-Za-z0-9_-]{22,128}")
READER_PATHS = ("/reports/", "/api/editions/")  # with "/": where the cookie is set when missing
MAX_OVERLAYS_PER_READER = 500


def json_depth(raw):
    """Deepest object/array nesting of a JSON text, counted before parsing (deep input would exhaust the parser)."""
    depth = deepest = 0
    in_str = esc = False
    for ch in raw.decode("utf-8", "replace"):
        if in_str:
            esc, in_str = (False, True) if esc else (ch == "\\", ch != '"')
        elif ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif ch in "]}":
            depth -= 1
    return deepest


class OverlayIn(BaseModel):
    kind: Literal["memo", "thread", "revision"]
    anchor: dict[str, Any] = {}
    body: dict[str, Any]
    parent_id: int | None = None


class OverlayPatch(BaseModel):
    anchor: dict[str, Any] | None = None
    body: dict[str, Any] | None = None


def status_line(ed):
    """Plain status words for the page; never says accepted unless the edition is."""
    s, cov = ed["status"], ed["producer"].get("coverage")
    done = {True: "complete", False: "incomplete", None: "unknown"}[s["delivery_complete"]]
    if cov:  # a partial edition: partial or complete comes from coverage; delivery_complete covers the stage only
        k, n = len(cov["produced"]), sum(map(len, cov.values()))
        done = "complete" if k == n else f"partial: {k} of {n} chapters"
    parts = [f"Shared edition R{ed['number']}", s["publication_disposition"].capitalize(),
             "Quality: " + s["quality_disposition"].replace("_", " "), f"Delivery {done}",
             f"Pipeline status: {s['native_status']}"]
    if ed["review_findings"]["count"]:
        parts.append(f"{ed['review_findings']['count']} open review findings")
    if s["quality_disposition"] != "accepted":
        parts.append("Not an accepted report")
    return " · ".join(parts)


@functools.lru_cache(maxsize=4)
def ui_parts(ui_dir):
    """The Desk's shell, CSS, JS and data marker, read once per process (the UI folder is a fixed build input)."""
    ui = pathlib.Path(ui_dir)
    mark = load_module(ui / "build.py", "athena_ui_build").MARK
    src = (ui / "src" / "shell.html").read_text()
    if src.count(mark) != 1 or src.count("/*APP_CSS*/") != 1 or src.count("/*APP_JS*/") != 1:
        raise RuntimeError("shell.html must contain the empty data block, /*APP_CSS*/ and /*APP_JS*/ exactly once")
    if src.count("<body>\n") != 1:
        raise RuntimeError("shell.html must contain one <body> line")
    css = (ui / "src" / "app.css").read_text().replace('url("fonts/', 'url("/fonts/')  # works from any page path
    return src, css, (ui / "src" / "app.js").read_text(), mark


def script_json(o):
    """JSON for a <script type="application/json"> element. No "<" at all is left inside, so "</script" and "<!--"
    cannot end or change the element (JSON reads \\u003c as "<")."""
    return json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


@functools.lru_cache(maxsize=4)
def chapter_map(ui_dir):
    """The app's canonical chapters as [id, title, question], read once per process."""
    return [list(c) for c in chapters(ui_dir)]


def app_config(ed, ui_dir, ask_live=False):
    """The frontend contract for app mode (the `app-config` slot): where the API is, for this edition. A partial edition
    (its delivery manifest carried `coverage`) adds the coverage and the canonical chapter map, so the Desk can number
    and list every chapter; the stored report itself holds only the produced chapters. With live answers on, `ask_url`
    is added (keyless, the slot is unchanged and the Desk keeps its sample answers)."""
    cfg = {"api_base": "/api", "edition_id": ed["id"], "reports_url": "/api/reports",
           "overlays_url": f"/api/editions/{ed['id']}/overlays"}
    if ask_live:
        cfg["ask_url"] = f"/api/editions/{ed['id']}/ask"
    cov = ed["producer"].get("coverage")
    return cfg | {"coverage": cov, "chapters": chapter_map(str(ui_dir))} if cov else cfg


def desk_page(ui_dir, doc, ed, status_strip=True, ask_live=False):
    """The Desk page, assembled like the UI's build.py, with this edition's client JSON in the report-data slot
    and the app-mode config in the app-config slot next to it."""
    src, css, js, mark = ui_parts(str(ui_dir))
    # Interim status strip until the Desk shows edition status itself (frontend task); then turn it off.
    strip = '' if not status_strip else (f'<div id="edition-status" role="status" data-quality="{html.escape(ed["status"]["quality_disposition"])}" '
             'style="background:#8a5300;color:#fff;font:600 11px/1.4 system-ui,sans-serif;padding:2px 8px;border-radius:4px">'
             f'{html.escape(status_line(ed))}</div>\n')
    src = src.replace("<body>\n", "<body>\n" + strip)
    src = src.replace("/*APP_CSS*/", css).replace("/*APP_JS*/", js)
    slots = (mark.replace("></script>", ">" + script_json(doc) + "</script>") + "\n"
             + f'<script type="application/json" id="app-config">{script_json(app_config(ed, ui_dir, ask_live))}</script>')
    return src.replace(mark, slots)


def create_app(db_path, ui_dir, hosts=HOSTS, status_strip=True, jobs_config=None, ask_config=None):
    app = FastAPI(title="Athena app", version="0.1.0")
    store.connect(db_path).close()  # migrations run once, here, before any request
    jobs_cfg = jobs.load_config(jobs_config)  # None: the jobs routes answer `disabled`
    ask_cfg = ask.load_config(ask_config, db_path)  # None: keyless, questions are saved and answered `disabled`

    def db():
        return store.connect(db_path, migrate=False)

    @app.middleware("http")
    async def write_requests(request: Request, call_next):
        """Writes carry JSON only (a cross-site form cannot send it without a preflight), within size and depth
        limits. A DELETE carries no body at all; it needs no Content-Type (it is never a CORS-simple request)."""
        if request.method == "DELETE":
            if "transfer-encoding" in request.headers or request.headers.get("content-length", "0") != "0":
                return JSONResponse({"detail": "DELETE takes no request body"}, 413)  # refused unread
        elif request.method in ("POST", "PUT", "PATCH"):
            if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                return JSONResponse({"detail": "Content-Type must be application/json"}, 415)
            size = request.headers.get("content-length")
            if "transfer-encoding" in request.headers:  # chunked bodies are not accepted on these routes
                if size is not None:  # RFC 9112 6.1: both framings at once is ambiguous (request smuggling)
                    return JSONResponse({"detail": "Transfer-Encoding with Content-Length"}, 400)
                return JSONResponse({"detail": "Content-Length required"}, 411)
            if size is None:
                return JSONResponse({"detail": "Content-Length required"}, 411)
            # a runner delivery with a valid token may carry 4 MiB of files; every other write (and an unauthorised delivery) 64 KB
            limit = jobs.MAX_DELIVERY_BODY if jobs.DELIVERY_PATH.fullmatch(request.url.path) \
                and jobs.token_ok(jobs_cfg, request.headers) else MAX_BODY
            if not (size.isascii() and size.isdigit()) or int(size) > limit:
                return JSONResponse({"detail": f"request body over {limit} bytes"}, 413)
            chunks, got = [], 0
            async for chunk in request.stream():  # count what really arrives; never buffer more than limit + 1
                got += len(chunk)
                if got > limit:
                    return JSONResponse({"detail": f"request body over {limit} bytes"}, 413)
                chunks.append(chunk)
            if got != int(size):
                return JSONResponse({"detail": "Content-Length does not match the body"}, 400)
            request._body = body = b"".join(chunks)  # what Request.body() would cache, for the route to read
            if json_depth(body) > MAX_DEPTH:
                return JSONResponse({"detail": f"JSON nested deeper than {MAX_DEPTH} levels"}, 422)
        response = await call_next(request)
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.middleware("http")
    async def reader(request: Request, call_next):
        """The reader id behind the overlay routes, from the browser's cookie (a new one when it has none). The
        store keeps only a hash of the cookie value."""
        given = request.cookies.get(READER_COOKIE, "")
        cookie = given if READER_VALUE.fullmatch(given) else secrets.token_urlsafe(16)
        request.state.reader = "r-" + store.sha256(cookie.encode())[:32]
        response = await call_next(request)
        if cookie != given and (request.url.path == "/" or request.url.path.startswith(READER_PATHS)):
            response.set_cookie(READER_COOKIE, cookie, max_age=365 * 24 * 3600, path="/", httponly=True,
                                samesite="lax", secure=request.url.scheme == "https")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def not_found_page(request: Request, exc):
        """A reader who mistypes a page address gets a page, not JSON; the API keeps its JSON errors."""
        if exc.status_code == 404 and not request.url.path.startswith("/api/"):
            return HTMLResponse(NOT_FOUND_PAGE, 404, headers=SECURITY_HEADERS)
        return await http_exception_handler(request, exc)

    @app.exception_handler(RequestValidationError)
    async def bad_page_id(request: Request, exc):
        if request.url.path.startswith("/reports/"):  # /reports/abc: no such report
            return HTMLResponse(NOT_FOUND_PAGE, 404, headers=SECURITY_HEADERS)
        if request.url.path.startswith(("/api/jobs", "/api/runner/")):  # never echo the input: it may hold the access code
            return JSONResponse({"detail": jsonable_encoder([{k: v for k, v in e.items() if k != "input"}
                                                             for e in exc.errors()])}, 422)
        return await request_validation_exception_handler(request, exc)

    def edition_or_404(conn, edition_id):
        ed = store.get_edition(conn, edition_id)
        if not ed:
            raise HTTPException(404, "edition not found")
        return ed

    @app.get("/api/health")
    def health():
        conn = db()
        try:
            return {"ok": True, "editions": len(store.list_editions(conn))}
        finally:
            conn.close()

    @app.get("/api/reports")
    def reports():
        conn = db()
        try:
            return store.list_editions(conn)
        finally:
            conn.close()

    @app.get("/api/reports/{edition_id}")
    def report(edition_id: Id):
        conn = db()
        try:
            ed = edition_or_404(conn, edition_id)
            return {"edition": ed, "document": client_doc(conn, ed)}
        finally:
            conn.close()

    @app.get("/api/editions/{edition_id}/overlays")
    def overlays(request: Request, edition_id: Id, kind: Literal["memo", "thread", "revision"] | None = None):
        conn = db()
        try:
            edition_or_404(conn, edition_id)
            return store.list_overlays(conn, edition_id, request.state.reader, kind)
        finally:
            conn.close()

    @app.post("/api/editions/{edition_id}/overlays", status_code=201)
    def add_overlay(request: Request, edition_id: Id, o: OverlayIn):
        user = request.state.reader
        conn = db()
        try:
            edition_or_404(conn, edition_id)
            if o.parent_id is not None and not store.get_overlay(conn, edition_id, user, o.parent_id):
                raise HTTPException(422, "parent overlay not found on this edition")
            if store.count_overlays(conn, user) >= MAX_OVERLAYS_PER_READER:
                raise HTTPException(429, f"a reader keeps at most {MAX_OVERLAYS_PER_READER} memos and threads")
            store.ensure_user(conn, user)
            return store.add_overlay(conn, edition_id, user, o.kind, o.anchor, o.body, o.parent_id)
        finally:
            conn.close()

    @app.patch("/api/editions/{edition_id}/overlays/{overlay_id}")
    def patch_overlay(request: Request, edition_id: Id, overlay_id: Id, o: OverlayPatch):
        conn = db()
        try:
            if not store.get_overlay(conn, edition_id, request.state.reader, overlay_id):
                raise HTTPException(404, "overlay not found")
            return store.update_overlay(conn, edition_id, request.state.reader, overlay_id, o.anchor, o.body)
        finally:
            conn.close()

    @app.delete("/api/editions/{edition_id}/overlays/{overlay_id}", status_code=204)
    def delete_overlay(request: Request, edition_id: Id, overlay_id: Id):
        conn = db()
        try:
            if not store.delete_overlay(conn, edition_id, request.state.reader, overlay_id):
                raise HTTPException(404, "overlay not found")
        except sqlite3.IntegrityError:  # intended: replies are never removed as a side effect
            raise HTTPException(409, "overlay has replies; delete them first")
        finally:
            conn.close()
        return Response(status_code=204)

    def client_doc(conn, ed):
        return client_view(with_created(store.get_document(conn, ed["doc_sha256"]), ed["created_at"]))

    def page(edition_id):
        conn = db()
        try:
            ed = edition_or_404(conn, edition_id)
            return HTMLResponse(desk_page(ui_dir, client_doc(conn, ed), ed, status_strip, bool(ask_cfg)))
        finally:
            conn.close()

    @app.get("/", response_class=HTMLResponse)
    def index():
        conn = db()
        try:
            eid = store.latest_edition_id(conn)
        finally:
            conn.close()
        if eid is None:
            return HTMLResponse("<!doctype html><title>Athena</title><p>No edition stored yet. "
                                "Run <code>python -m athena_app.ingest</code> first.</p>", status_code=404)
        return page(eid)

    @app.get("/reports/{edition_id}", response_class=HTMLResponse)
    def report_page(edition_id: Id):
        return page(edition_id)

    jobs.add_routes(app, db, ui_dir, jobs_cfg)
    ask.add_routes(app, db, db_path, lambda conn, eid: client_doc(conn, edition_or_404(conn, eid)), ask_cfg, jobs_cfg)
    app.mount("/fonts", StaticFiles(directory=pathlib.Path(ui_dir) / "fonts"), name="fonts")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(hosts))  # a local app: refuse other Host names
    return app


def main(argv=None):
    import uvicorn
    env = os.environ.get
    p = argparse.ArgumentParser(prog="python -m athena_app.server")
    p.add_argument("--db", default=env("ATHENA_DB", "athena.db"))
    p.add_argument("--ui", default=env("ATHENA_UI"), required=not env("ATHENA_UI"))
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-status-strip", action="store_true", help="leave out the interim edition status strip")
    p.add_argument("--jobs-config", default=env("ATHENA_JOBS_CONFIG"), help="live report jobs config (JSON); off without it")
    p.add_argument("--ask-config", default=env("ATHENA_ASK_CONFIG"), help="live Ask config (JSON); keyless without it")
    a = p.parse_args(argv)
    uvicorn.run(create_app(a.db, a.ui, hosts={*HOSTS, a.host}, status_strip=not a.no_status_strip,
                           jobs_config=a.jobs_config, ask_config=a.ask_config), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
