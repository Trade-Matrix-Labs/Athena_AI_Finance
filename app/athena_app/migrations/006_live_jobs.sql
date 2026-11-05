-- Live report jobs. Replaces the placeholder jobs tables of 001, which no code ever wrote.
-- A job is admitted by the judge API, claimed by exactly one runner, and ends ready (with an edition), failed or
-- refused. 'unknown' is never stored: it is how a claimed, running or ingesting job with no runner contact for
-- stale_minutes reads, and such a job is never claimed again.
DROP TABLE job_events;
DROP TABLE jobs;

CREATE TABLE jobs (
  job_id            TEXT PRIMARY KEY,            -- random, 32 hex digits
  client_request_id TEXT NOT NULL UNIQUE,        -- the browser's idempotency key
  input_sha256      TEXT NOT NULL,               -- fingerprint of (filing_id, language, client_id) for that key
  client_id         TEXT NOT NULL,
  filing_id         TEXT NOT NULL,
  language          TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('requested', 'claimed', 'running', 'ingesting', 'ready', 'failed', 'refused')),
  created_at        TEXT NOT NULL,
  claimed_at        TEXT,
  seen_at           TEXT,                        -- last runner contact (claim, events, delivery), server clock
  ended_at          TEXT,
  runner_id         TEXT,
  edition_id        INTEGER REFERENCES editions(id),
  error_json        TEXT,
  spend_usd         REAL                         -- the runner's running total, display only
);
CREATE INDEX jobs_state ON jobs (state, created_at);
CREATE INDEX jobs_client ON jobs (client_id);

CREATE TABLE job_events (
  job_id      TEXT NOT NULL REFERENCES jobs(job_id),
  seq         INTEGER NOT NULL,
  line_json   TEXT NOT NULL,                     -- one progress line as received (known fields only)
  received_at TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);
