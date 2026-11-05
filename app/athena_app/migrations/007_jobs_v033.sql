-- Claim tokens, runner availability, idempotent operations and event sequence
-- numbers, the public `stopped` state, and client_request_id unique per client_id. The jobs table is
-- rebuilt with the 12-step procedure (as in 005), keeping its rows. A job claimed before this migration has no claim
-- token, so no runner can write to it again: it reads unknown and an operator ends it (athena_app.jobs_admin).
CREATE TABLE new_jobs (
  job_id             TEXT PRIMARY KEY,           -- random, 32 hex digits
  client_request_id  TEXT NOT NULL,              -- the browser's idempotency key, unique per client_id
  input_sha256       TEXT NOT NULL,              -- fingerprint of (filing_id, language) for that key
  client_id          TEXT NOT NULL,
  filing_id          TEXT NOT NULL,
  language           TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('requested', 'claimed', 'running', 'ingesting', 'ready', 'failed',
                                                    'refused', 'stopped')),
  created_at         TEXT NOT NULL,
  claimed_at         TEXT,
  seen_at            TEXT,                       -- last runner contact (claim, events, delivery), server clock
  ended_at           TEXT,
  runner_id          TEXT,
  claim_request_id   TEXT UNIQUE,                -- the runner's durable claim key
  claim_token_sha256 TEXT,                       -- only the hash of the claim token is stored
  last_seq           INTEGER NOT NULL DEFAULT 0,
  edition_id         INTEGER REFERENCES editions(id),
  error_json         TEXT,                       -- {code, count, errors}; the public view shows code and count only
  spend_usd          REAL,                       -- the runner's running total, display only; NULL when not observed
  UNIQUE (client_id, client_request_id)
);
INSERT INTO new_jobs (job_id, client_request_id, input_sha256, client_id, filing_id, language, state, created_at,
                      claimed_at, seen_at, ended_at, runner_id, last_seq, edition_id, error_json, spend_usd)
  SELECT job_id, client_request_id, input_sha256, client_id, filing_id, language, state, created_at, claimed_at,
         seen_at, ended_at, runner_id, (SELECT coalesce(max(seq), 0) FROM job_events e WHERE e.job_id = jobs.job_id),
         edition_id, error_json, spend_usd
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE new_jobs RENAME TO jobs;
CREATE INDEX jobs_state ON jobs (state, created_at);
CREATE INDEX jobs_client ON jobs (client_id);

-- delivery and result requests, by operation id: a repeat returns the stored response
CREATE TABLE job_operations (
  job_id         TEXT NOT NULL REFERENCES jobs(job_id),
  operation_id   TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('delivery', 'result')),
  request_sha256 TEXT NOT NULL,
  response_json  TEXT,                           -- NULL until the operation has completed
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  PRIMARY KEY (job_id, operation_id)
);

-- the runner's latest availability report; one row, the latest report wins
CREATE TABLE runner_availability (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  state       TEXT NOT NULL CHECK (state IN ('available', 'disabled', 'cap_reached')),
  reason      TEXT,
  reported_at TEXT NOT NULL
);
