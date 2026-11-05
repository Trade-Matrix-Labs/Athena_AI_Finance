"""Regressions in app mode: page addresses that name no report get an HTML page (the
API keeps JSON errors), and every response carries the security headers (pages cannot be framed)."""
import pytest
from fastapi.testclient import TestClient

from athena_app.server import SECURITY_HEADERS, create_app
from conftest import UI

LOCAL = "http://127.0.0.1"


@pytest.fixture
def client(db_path, seeded):
    with TestClient(create_app(db_path, UI), base_url=LOCAL) as c:
        yield c


def test_unknown_report_pages_are_html_404(client):
    for path in ("/reports/2", "/reports/abc", "/reports/0", "/no-such-page"):
        r = client.get(path)
        assert r.status_code == 404 and r.headers["content-type"].startswith("text/html"), path
        assert "not found" in r.text and "{" not in r.text, path


def test_api_errors_stay_json(client):
    assert client.get("/api/reports/999").json() == {"detail": "edition not found"}
    assert client.get("/api/reports/abc").status_code == 422
    assert client.get("/api/no-such").headers["content-type"].startswith("application/json")


def test_security_headers_on_pages_and_api(client, seeded):
    for path in ("/", f"/reports/{seeded}", "/api/health", "/reports/abc"):
        h = client.get(path).headers
        for k, v in SECURITY_HEADERS.items():
            assert h.get(k) == v, (path, k)
    assert "frame-ancestors 'none'" in SECURITY_HEADERS["Content-Security-Policy"]
