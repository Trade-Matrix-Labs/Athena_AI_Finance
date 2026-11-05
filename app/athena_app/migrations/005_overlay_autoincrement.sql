-- overlays.id was a plain INTEGER PRIMARY KEY, so SQLite reused the id of a deleted last row and a stale
-- browser tab could PATCH or DELETE a newer overlay. AUTOINCREMENT never reuses an id. This is the 12-step table
-- rebuild of https://www.sqlite.org/lang_altertable.html ("Making Other Kinds Of Table Schema Changes"); the
-- migration runner does steps 1 (foreign_keys off), 2 and 10-12 (transaction, foreign_key_check, commit, restore).
-- Existing rows keep their ids; the sequence starts at the highest surviving id (earlier deleted ids are unknown).
CREATE TABLE new_overlays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  edition_id  INTEGER NOT NULL REFERENCES editions(id),
  kind        TEXT NOT NULL CHECK (kind IN ('memo', 'thread', 'revision')),
  parent_id   INTEGER REFERENCES overlays(id),
  anchor_json TEXT NOT NULL,
  body_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
INSERT INTO new_overlays (id, user_id, edition_id, kind, parent_id, anchor_json, body_json, created_at, updated_at)
  SELECT id, user_id, edition_id, kind, parent_id, anchor_json, body_json, created_at, updated_at FROM overlays;
DROP TABLE overlays;
ALTER TABLE new_overlays RENAME TO overlays;
CREATE INDEX overlays_edition ON overlays (edition_id, user_id);
