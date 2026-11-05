"""Fake report runner for UI work and demos. It reports itself available, claims one job, posts a few progress
lines, then uploads the R14 fixture (a draft, review-required report) as the delivery. It makes no model call and
reports no spend (the job's spend stays null).

python -B -m athena_app.fake_runner --app http://127.0.0.1:8000 --token-file <file> [--delay 2] [--wait 0]
    [--runner-id fake-runner] [--state available|disabled|cap_reached]
With --state disabled or cap_reached it only reports that availability and exits. Plain http:// is refused except
to a loopback host (the runner token must not cross a network in clear text).
Exit 0 when the job ends ready, when no job was waiting, or after a --state report; 1 otherwise. Standard library only.
"""
import argparse
import base64
import datetime
import ipaddress
import json
import pathlib
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FIXTURE = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "r14"
FILES = ("REPORT.json", "DELIVERY-MANIFEST.json", "EDITION-STATUS.json")
STAGES = [("start", "started", "fake runner: no model call; it replays the R14 fixture"),
          ("filing", "done", "filing loaded"),
          ("chapters", "started", "writing 16 chapters"),
          ("chapters", "done", "16 chapters written"),
          ("checks", "done", "structural checks passed"),
          ("delivery", "started", "uploading the delivery")]
HEARTBEAT = 30  # seconds between availability reports; the app's availability_ttl_seconds is longer (default 120)


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def url_ok(app):
    """https:// anywhere; http:// only to a loopback host."""
    u = urllib.parse.urlsplit(app)
    return bool(u.hostname) and (u.scheme == "https" or (u.scheme == "http" and loopback(u.hostname)))


def call(app, token, path, body=None, claim=None):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if claim:
        headers["X-Claim-Token"] = claim
    req = urllib.request.Request(app.rstrip("/") + path, method="GET" if body is None else "POST", headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, (json.loads(r.read()) if r.status != 204 else None)


def run(app, token, runner_id="fake-runner", delay=2.0, wait=0.0, delivery=FIXTURE, log=print):
    """Claim one job and finish it. Returns the final job, or None when no job was waiting."""
    if not url_ok(app):
        raise ValueError("the app URL must be https://, or http:// to a loopback host")
    claim_request_id = f"{runner_id}:{secrets.token_hex(12)}"  # one claim attempt: the same id on every retry
    deadline, beat = time.monotonic() + wait, 0.0

    def heartbeat():
        nonlocal beat
        if time.monotonic() - beat >= HEARTBEAT:
            call(app, token, "/api/runner/availability", {"state": "available"})
            beat = time.monotonic()

    while True:
        heartbeat()
        status, job = call(app, token, "/api/runner/claim", {"runner_id": runner_id,
                                                              "claim_request_id": claim_request_id})
        if status != 204:
            break
        if time.monotonic() >= deadline:
            log("no job waiting")
            return None
        time.sleep(1)
    jid, claim = job["job_id"], job["claim_token"]  # the claim token is never printed
    log(f"claimed job {jid} ({job['filing_id']}, {job['language']})")
    for seq, (stage, state, note) in enumerate(STAGES, 1):
        time.sleep(delay)
        heartbeat()
        ts = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        call(app, token, f"/api/runner/jobs/{jid}/events",
             [{"job_id": jid, "seq": seq, "stage": stage, "status": state, "ts": ts, "note": note}], claim)
        log(f"event {seq} {stage} {state}")
    files = {n: base64.b64encode((delivery / n).read_bytes()).decode() for n in FILES if (delivery / n).is_file()}
    _, out = call(app, token, f"/api/runner/jobs/{jid}/delivery",
                  {"operation_id": f"delivery-{secrets.token_hex(8)}", "files": files}, claim)
    log(f"job {jid}: {out['state']}" + (f", edition {out['edition_id']}" if out["edition_id"] else "")
        + (f", error {out['error']['code']}" if out["error"] else ""))
    return out


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m athena_app.fake_runner", description=__doc__.splitlines()[0])
    p.add_argument("--app", required=True, help="the app's base URL, e.g. http://127.0.0.1:8000")
    p.add_argument("--token-file", required=True, help="file holding the runner token")
    p.add_argument("--delay", type=float, default=2.0, help="seconds between progress lines")
    p.add_argument("--wait", type=float, default=0.0, help="seconds to keep asking for a job (default: ask once)")
    p.add_argument("--runner-id", default="fake-runner")
    p.add_argument("--state", choices=["available", "disabled", "cap_reached"], default="available",
                   help="disabled or cap_reached: report it and exit")
    a = p.parse_args(argv)
    if not url_ok(a.app):
        p.error("--app must be an https:// URL, or http:// to a loopback host (127.0.0.1, ::1, localhost)")
    token = pathlib.Path(a.token_file).read_text().strip()
    try:
        if a.state != "available":
            reason = "cap_reached" if a.state == "cap_reached" else "unavailable"
            call(a.app, token, "/api/runner/availability", {"state": a.state, "reason": reason})
            print(f"reported {a.state}")
            return 0
        out = run(a.app, token, a.runner_id, a.delay, a.wait)
    except urllib.error.HTTPError as e:  # the app's answer; it never contains a token
        print(f"refused: HTTP {e.code} {e.read()[:500].decode('utf-8', 'replace')}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"cannot reach the app: {e.reason}", file=sys.stderr)
        return 1
    return 0 if out is None or out["state"] == "ready" else 1


if __name__ == "__main__":
    sys.exit(main())
