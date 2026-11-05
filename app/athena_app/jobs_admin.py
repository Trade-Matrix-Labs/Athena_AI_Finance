"""Operator commands for live report jobs, on the local database only (there is no HTTP route for them).

python -B -m athena_app.jobs_admin [--db athena.db] [--stale-minutes 20] list
python -B -m athena_app.jobs_admin [--db athena.db] [--stale-minutes 20] end <job_id> --reason operator_closed

`end` closes a job that reads unknown (claimed, running or ingesting with no runner contact for stale-minutes; use
the server's stale_minutes): it becomes failed with reason operator_closed and stops counting as active. Any other job is refused: a live job ends through its runner, a finished one is already closed.
"""
import argparse
import json
import os
import pathlib
import sys

from . import store
from .jobs import ago, failure, state_of, transaction


def main(argv=None):
    p = argparse.ArgumentParser(prog="python -m athena_app.jobs_admin", description=__doc__.splitlines()[0])
    p.add_argument("--db", default=os.environ.get("ATHENA_DB", "athena.db"))
    p.add_argument("--stale-minutes", type=int, default=20, help="the server's stale_minutes (default 20)")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="jobs that are active or unknown")
    end = sub.add_parser("end", help="end an unknown job: failed, operator_closed")
    end.add_argument("job_id")
    end.add_argument("--reason", required=True, choices=["operator_closed"])
    a = p.parse_args(argv)
    if a.stale_minutes < 1:
        p.error("--stale-minutes must be at least 1")
    if not pathlib.Path(a.db).is_file():  # never create a database here
        print(f"no database at {a.db}", file=sys.stderr)
        return 1
    conn = store.connect(a.db, migrate=False)
    try:
        cutoff = ago(minutes=a.stale_minutes)
        if a.command == "list":
            for r in conn.execute("SELECT * FROM jobs WHERE state IN ('requested', 'claimed', 'running', 'ingesting')"
                                  " ORDER BY created_at"):
                print(r["job_id"], state_of(r, cutoff), r["filing_id"], r["language"], r["created_at"],
                      r["seen_at"] or "-")
            return 0
        with transaction(conn):
            r = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (a.job_id,)).fetchone()
            if not r:
                print(f"no job {a.job_id}", file=sys.stderr)
                return 1
            if (state := state_of(r, cutoff)) != "unknown":
                print(f"job {a.job_id} is {state}, not unknown; not changed", file=sys.stderr)
                return 1
            conn.execute("UPDATE jobs SET state = 'failed', error_json = ?, ended_at = ? WHERE job_id = ?",
                         (json.dumps(failure(a.reason)), store.now(), a.job_id))
        print(f"job {a.job_id}: unknown -> failed ({a.reason})")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
