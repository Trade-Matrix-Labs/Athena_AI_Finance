-- An edition is immutable. Its document bytes, hashes, validation result (with its review findings)
-- and pipeline status fields never change and nothing is deleted. Only the two dispositions may change, and only
-- toward stricter (quality: failed < review_required < unreviewed < accepted; publication: withdrawn < draft < published).
CREATE TRIGGER documents_no_update BEFORE UPDATE ON documents
BEGIN SELECT RAISE(ABORT, 'stored documents are immutable'); END;

CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents
BEGIN SELECT RAISE(ABORT, 'stored documents are immutable'); END;

CREATE TRIGGER editions_no_delete BEFORE DELETE ON editions
BEGIN SELECT RAISE(ABORT, 'editions cannot be deleted'); END;

CREATE TRIGGER editions_fixed BEFORE UPDATE ON editions
WHEN NEW.id IS NOT OLD.id OR NEW.accession IS NOT OLD.accession OR NEW.language IS NOT OLD.language
 OR NEW.number IS NOT OLD.number OR NEW.doc_sha256 IS NOT OLD.doc_sha256 OR NEW.source_sha256 IS NOT OLD.source_sha256
 OR NEW.delivery_complete IS NOT OLD.delivery_complete OR NEW.native_status IS NOT OLD.native_status
 OR NEW.producer_json IS NOT OLD.producer_json OR NEW.validation_json IS NOT OLD.validation_json
 OR NEW.created_at IS NOT OLD.created_at OR NEW.status_detail_json IS NOT OLD.status_detail_json
BEGIN SELECT RAISE(ABORT, 'edition fields are immutable; only the dispositions may move, toward stricter'); END;

CREATE TRIGGER editions_stricter_only BEFORE UPDATE OF quality_disposition, publication_disposition ON editions
WHEN (CASE NEW.quality_disposition WHEN 'failed' THEN 0 WHEN 'review_required' THEN 1 WHEN 'unreviewed' THEN 2 ELSE 3 END)
   > (CASE OLD.quality_disposition WHEN 'failed' THEN 0 WHEN 'review_required' THEN 1 WHEN 'unreviewed' THEN 2 ELSE 3 END)
  OR (CASE NEW.publication_disposition WHEN 'withdrawn' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END)
   > (CASE OLD.publication_disposition WHEN 'withdrawn' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END)
BEGIN SELECT RAISE(ABORT, 'an edition status may only become stricter'); END;

-- every edition carries its review findings list, and a new edition's findings are all open
CREATE TRIGGER editions_findings_listed BEFORE INSERT ON editions
WHEN json_type(NEW.validation_json, '$.review_findings') IS NOT 'array'
 OR EXISTS (SELECT 1 FROM json_each(NEW.validation_json, '$.review_findings')
            WHERE json_extract(value, '$.status') IS NOT 'open')
BEGIN SELECT RAISE(ABORT, 'a new edition needs its review_findings list, all open'); END;
