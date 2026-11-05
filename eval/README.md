# Ask FAQ eval, R14 (Palantir FY2025 10-K, draft edition)

`ask-faq-r14.json`: 24 reader questions for the Ask agent. Offline regression fixture and question list for a live run.
Written from `app/fixtures/r14/REPORT.json` only; the edition is a draft with open review findings, so expectations follow the report text, not the filing.

## Format
List of `{id, question, category, intent?, anchor_id?, expected_state, expected_citation_ids_any, required_numbers, notes}`.
- `expected_state`: `answered | refused | cannot_answer | needs_approval`.
- `expected_citation_ids_any`: served ids of every element that holds the answer; citing any one counts. Empty for refused, cannot_answer and needs_approval.
- `required_numbers`: strings exactly as the served text shows them (reported facts print as `4,475,446` in thousands of USD, `$4.1 billion`, `38%`). Calculated facts (margins, growth, tax rate) have no printed form, so they are not listed; an answer's rounded figure for them is checked by the App's ratio x 100 rule.
- `notes`: a note starting `[profitability]` marks the profitability items; other notes record scale, sign and ambiguity caveats.

## Served ids (read-only from `app/athena_app/`)
`adapter.py` `adapt_v2_to_v3` turns the v2 report into the served document and `ask.py` `index` lists the citable ids:
the cover is `summary` (its blocks keep their ids, plus `cover-kpis`); each other chapter id is its v2 section id except
`cashflow`->`cash-flow`, `quality`->`earnings-quality`, `balance`->`balance-sheet`; every block id is kept; the `glossary` section's
`**Term.** Definition` blocks become glossary entries (`glossary-N`) and the `glossary` chapter itself is not an id; the `sources` chapter
stays (`sources`, `sources-boundary`); sources (`src-NN`) and facts (`revenue-fy2025`, `t-21`, ...) keep their v2 ids.
The number check text comes from `ask.py` `support` (block text with `{fact:id}` tokens replaced by the facts' label, period, printed form and value).
`check_faq.py` rebuilds both from REPORT.json (288 ids) and was cross-checked against the real adapter and `index` (identical id sets).

## Counts
factual 12 (5 profitability), why 4, comparison 2, define_term 2, explain_figure 1, write_request 1, advice 1, cannot_answer 1 = 24.
Expected states: answered 21, needs_approval 1, refused 1, cannot_answer 1.

## Run
`python -I -B check_faq.py [faq.json] [REPORT.json]` (stdlib only; exit 1 on any failure).
