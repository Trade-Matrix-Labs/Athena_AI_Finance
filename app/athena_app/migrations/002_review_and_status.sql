-- Review findings, and an edition with any open review finding cannot be accepted or published, by any write path.
CREATE TRIGGER editions_guard_insert BEFORE INSERT ON editions
WHEN (NEW.quality_disposition = 'accepted' OR NEW.publication_disposition = 'published')
 AND EXISTS (SELECT 1 FROM json_each(NEW.validation_json, '$.review_findings') WHERE json_extract(value, '$.status') = 'open')
BEGIN SELECT RAISE(ABORT, 'edition has open review findings: cannot be accepted or published'); END;

CREATE TRIGGER editions_guard_update BEFORE UPDATE ON editions
WHEN (NEW.quality_disposition = 'accepted' OR NEW.publication_disposition = 'published')
 AND EXISTS (SELECT 1 FROM json_each(NEW.validation_json, '$.review_findings') WHERE json_extract(value, '$.status') = 'open')
BEGIN SELECT RAISE(ABORT, 'edition has open review findings: cannot be accepted or published'); END;

-- the pipeline's edition status detail (delivery_complete_scope, native_final_verified,
-- final_store_reopen_verified) and where the four status fields came from
ALTER TABLE editions ADD COLUMN status_detail_json TEXT NOT NULL DEFAULT '{}';
