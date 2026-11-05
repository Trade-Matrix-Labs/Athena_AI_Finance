-- Athena app store v1. Shared editions are immutable;
-- personal overlays live in their own table and never change an edition.

CREATE TABLE filings (
  accession     TEXT PRIMARY KEY,
  issuer        TEXT NOT NULL,
  ticker        TEXT,
  form          TEXT NOT NULL,
  fiscal_year   INTEGER,
  period_end    TEXT,
  filing_sha256 TEXT
);

-- content-addressed bytes: the delivered v2 report and the adapted v3 document
CREATE TABLE documents (
  sha256 TEXT PRIMARY KEY,
  bytes  BLOB NOT NULL
);

CREATE TABLE editions (
  id                      INTEGER PRIMARY KEY,
  accession               TEXT NOT NULL REFERENCES filings(accession),
  language                TEXT NOT NULL,
  number                  INTEGER NOT NULL,
  doc_sha256              TEXT NOT NULL UNIQUE REFERENCES documents(sha256),
  source_sha256           TEXT NOT NULL UNIQUE REFERENCES documents(sha256),
  delivery_complete       INTEGER,            -- 1, 0 or NULL (manifest did not say)
  native_status           TEXT NOT NULL,      -- pipeline status, or 'unknown'
  quality_disposition     TEXT NOT NULL CHECK (quality_disposition IN ('unreviewed', 'review_required', 'failed', 'accepted')),
  publication_disposition TEXT NOT NULL CHECK (publication_disposition IN ('draft', 'published', 'withdrawn')),
  producer_json           TEXT NOT NULL,
  validation_json         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  UNIQUE (accession, language, number)
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  accession     TEXT,
  language      TEXT,
  status        TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  delivery_path TEXT
);

CREATE TABLE job_events (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  seq    INTEGER NOT NULL,
  stage  TEXT NOT NULL,
  status TEXT NOT NULL,
  ts     TEXT NOT NULL,
  note   TEXT,
  PRIMARY KEY (job_id, seq)
);

-- placeholder until auth exists
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
INSERT INTO users (id, display_name) VALUES ('demo', 'Demo reader');

CREATE TABLE overlays (
  id          INTEGER PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  edition_id  INTEGER NOT NULL REFERENCES editions(id),
  kind        TEXT NOT NULL CHECK (kind IN ('memo', 'thread', 'revision')),
  parent_id   INTEGER REFERENCES overlays(id),
  anchor_json TEXT NOT NULL,
  body_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX overlays_edition ON overlays (edition_id, user_id);
