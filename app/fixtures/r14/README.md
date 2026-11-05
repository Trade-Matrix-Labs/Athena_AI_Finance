# R14 integration fixture

`REPORT.json` is a ReportDocument v2 from one pipeline delivery (labelled "pipeline delivery R14"),
copied byte for byte (sha256 `0c62f515…4d1e`, 125,787 bytes). `DELIVERY-MANIFEST.json` is a small
manifest derived for this repo: the report hash and the delivery's own status flags
(`final_available` false, `native_status` "HOLD"). `EDITION-STATUS.json` is the pipeline's edition status sidecar for
this report, copied byte for byte (sha256 `da1b24f8…`): delivery complete (a cover and all 16 chapters only),
`native_status` HOLD, `review_required`, `draft`.

**This is a draft, review-required integration fixture, not an accepted report.** Its figures and
quotes come from Palantir Technologies Inc.'s FY2025 Form 10-K, but the document has not passed a
financial quality review. Use it to test ingest, the adapter and the API, never as a published report.
It ingests with 23 open review findings and no integrity errors (see the main README).
