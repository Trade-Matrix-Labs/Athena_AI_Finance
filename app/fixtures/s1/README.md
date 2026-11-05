# S1 partial-edition fixture (synthetic)

**A synthetic one-chapter fake, not model output and not a report.** It exists to test progressive
delivery: `REPORT.json` (ReportDocument v2) carries a cover and one chapter, Profitability, built from a handful of
figures quoted from Palantir Technologies Inc.'s FY2025 Form 10-K. `DELIVERY-MANIFEST.json` carries
`coverage` {"produced": ["profitability"], "failed": [], "planned": the other 12 chapter ids}. `EDITION-STATUS.json`
says `delivery_complete` true with `delivery_complete_scope` "S1: 1 of 13 chapters", `review_required`, `draft`,
native status `HOLD`.

`delivery_complete` true here means only that every unit requested for stage S1 was delivered; it does not mean the
report is complete. The App takes partial or complete from `coverage` (1 of 13 chapters produced), never from
`delivery_complete`.

The tests check the structure, not file hashes.
Use it to test ingest, the API and the Desk's partial-edition display, never as a published report.
