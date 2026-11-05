-- INSERT OR REPLACE deletes the conflicting row without firing DELETE triggers (unless
-- recursive_triggers is on), so it bypassed the immutability guards of 003. A BEFORE INSERT trigger fires before
-- any conflict is resolved, so these guards hold for every connection and every conflict clause (REPLACE, IGNORE,
-- plain). Callers that may meet an existing row must test for it first (store.put_document does).
CREATE TRIGGER documents_no_replace BEFORE INSERT ON documents
WHEN EXISTS (SELECT 1 FROM documents WHERE sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'stored documents are immutable'); END;

-- an edition is identified by its id, its (accession, language, number), and its two document hashes
CREATE TRIGGER editions_no_replace BEFORE INSERT ON editions
WHEN EXISTS (SELECT 1 FROM editions WHERE id = NEW.id OR doc_sha256 = NEW.doc_sha256 OR source_sha256 = NEW.source_sha256
             OR (accession = NEW.accession AND language = NEW.language AND number = NEW.number))
BEGIN SELECT RAISE(ABORT, 'editions cannot be replaced'); END;

-- Triggers fire newest first. Recreate 003's findings guard (unchanged) after the guards above so that it still
-- reports first, as it did before this migration.
DROP TRIGGER editions_findings_listed;
CREATE TRIGGER editions_findings_listed BEFORE INSERT ON editions
WHEN json_type(NEW.validation_json, '$.review_findings') IS NOT 'array'
 OR EXISTS (SELECT 1 FROM json_each(NEW.validation_json, '$.review_findings')
            WHERE json_extract(value, '$.status') IS NOT 'open')
BEGIN SELECT RAISE(ABORT, 'a new edition needs its review_findings list, all open'); END;
