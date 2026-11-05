# Athena app

A local app that ingests one report delivery and serves it in the Athena Desk. Licence: Apache-2.0.

**Architecture.** `ingest` reads a delivery folder (`REPORT.json`, a ReportDocument v2, plus `DELIVERY-MANIFEST.json`), checks the
report's sha256 against the manifest, adapts it to ReportDocument v3 (`athena_app/adapter.py`: deterministic, reuses the
pipeline's own text, writes no new reader text), runs the report checker (`check_report.py`, loaded from its own file) and
stores everything in one SQLite transaction (WAL, plain SQL migrations in `athena_app/migrations/`, run once when the server
starts, each under one write lock so a concurrent ingest process waits instead of failing). Editions are immutable and
content-addressed. The document hash covers the adapted document, which includes the edition number, the chapter map and the
adapter version; it never depends on the time of ingest, so the same delivery adapted the same way has the same sha256 in any
store at any time (the ingest time is kept on the edition row and added to the document when it is served).
Integrity errors refuse the whole delivery; review findings are stored with the edition (below). Each edition keeps four separate
status fields (`delivery_complete`, `native_status`, `quality_disposition` with default `unreviewed`, `publication_disposition`
with default `draft`). Personal overlays (memo, thread, revision) live in their own table. The FastAPI server returns JSON and
builds the Desk page from the UI sources, with the edition's client JSON in the `report-data` slot and its status shown on the page
(an interim strip; `--no-status-strip`, or `create_app(..., status_strip=False)`, leaves it out).

**Run** (Python 3.12+, `fastapi`, `uvicorn`; tests also need `pytest`, `httpx` and the `.[ask]` extra, since `test_ask.py` imports `langchain_core`). Run from this folder:

```
export ATHENA_UI=<desk ui folder> ATHENA_CHECKER=<check_report.py> ATHENA_FILING=<filing .htm> ATHENA_DB=athena.db
python -B -m athena_app.ingest <delivery_dir> [--status-sidecar <edition status json>]
python -B -m athena_app.server --port 8000        # open http://127.0.0.1:8000/
python -B -m pytest -q
```

API: `GET /api/health`, `GET /api/reports`, `GET /api/reports/{edition_id}`, `GET|POST /api/editions/{edition_id}/overlays`,
`PATCH|DELETE /api/editions/{edition_id}/overlays/{overlay_id}`; pages `/` (latest edition) and `/reports/{edition_id}`.
Overlays belong to the browser that wrote them: the pages and the overlay API set a random
`athena_reader` cookie (HttpOnly, SameSite=Lax, Secure over HTTPS, one year) when the browser has none, and every overlay
route reads and writes only that reader's memos and threads (the store keeps a hash of the cookie, never the cookie). A
reader keeps at most 500 overlays (else 429). Same-origin `fetch` calls send the cookie, so the Desk needs no change.
Overlays written before this change belong to the old shared `demo` reader and are no longer listed.
POST, PUT and PATCH must send `Content-Type: application/json` and a `Content-Length` of at most 64 KB, with at most 8 levels of
JSON nesting (else 415, 411, 413 or 422). The server counts the bytes that really arrive: more than 64 KB returns 413, a count
that differs from `Content-Length` returns 400, and `Transfer-Encoding` together with `Content-Length` returns 400 (RFC 9112 §6.1). DELETE needs no headers and takes no body: a `Content-Length` above 0 or any
`Transfer-Encoding` returns 413 without the body being read. No CORS headers are sent. Every response carries `nosniff`, `no-referrer` and frame-denial headers
(`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`); a page address that names no report gets an HTML not-found page,
while the API keeps its JSON errors. The server answers only to the Host
names `127.0.0.1` and `localhost` (plus `--host`). Deleting an overlay that has
replies returns 409 on purpose: replies are never removed as a side effect, so delete them first. Tests fail when the UI,
checker or filing inputs are missing; `ATHENA_SKIP_MISSING_INPUTS=1` skips the suite instead.
**Frontend contract (app mode).** Both pages carry two JSON slots, escaped the same way (no `<` inside; JSON reads `\u003c`):
`<script type="application/json" id="report-data">` holds the edition's client document, and right after it
`<script type="application/json" id="app-config">` holds
`{"api_base": "/api", "edition_id": <id>, "reports_url": "/api/reports", "overlays_url": "/api/editions/<id>/overlays"}`.
A page with an `app-config` slot is served by this app; the static Desk build has none. With live Ask configured (below)
the slot also carries `ask_url` (`/api/editions/<id>/ask`); without it the slot is unchanged.
A `{quote:src-id}` token in report text is served as that source's quote in typographic quotation marks (no citation is
added; the author's own `[src-id]` follows), so the Desk, Ask and its number check read the same words. This happens when
the document is served: the stored bytes and `doc_sha256` keep the token. An unknown source id refuses the ingest.

`fixtures/r14/` is a draft, review-required integration fixture, not an accepted report (see `fixtures/r14/README.md`).

**Partial editions** (progressive delivery). A delivery may carry fewer chapters than the app's 13. Its manifest then names
them in `coverage`: {`produced`, `failed`, `planned`}, lists of chapter ids (`planned`: not attempted in this run;
`failed`: attempted, did not pass the checks, absent from REPORT.json). Ingest refuses the delivery unless the three lists
are well formed, name each of the 13 chapters exactly once, and `produced` is exactly the chapters REPORT.json carries.
The stored report stays sparse (no placeholder chapters). The coverage is kept with the edition (`producer.coverage` in the
API `edition` object), and the Desk page's `app-config` slot adds `coverage` and the canonical chapter map
(`chapters`: [id, title, question]) so the Desk numbers every chapter in canonical order and shows the missing ones as not
in this edition. A partial edition's sidecar `delivery_complete` is stage-scoped (`delivery_complete_scope`
"<stage>: <k> of 13 chapters"; true means only that every chapter requested for that stage arrived), so the status strip,
the Desk's status details and the ingest output read partial or complete from `coverage` ("Delivery partial: 1 of 13
chapters"), never from `delivery_complete`; the stored status fields stay exactly as the sidecar has them. A scope in that
form that disagrees with the coverage is refused; other scope wording is free text. An edition without `coverage` is
served exactly as before. `fixtures/s1/` is a synthetic one-chapter fake for this (see `fixtures/s1/README.md`).

**Two classes of check findings** (`athena_app/validate.py`). *Integrity errors* refuse the whole delivery
and nothing is stored: hash mismatch, schema or adapter error, an id that breaks the id rule (below), an unresolved fact or source reference, a table cell that is not a fact, a quote not found in the
filing (including the lead-in, rows and closing text of a filing table), a shown value not found in its quote, and every
checker message not listed next.
*Review findings* do not refuse: quote length, period naming, sign or unit wording, and a chapter without a key point. They
are stored as open findings with the edition (`review_findings` in the API `edition` object), and while any is open the
edition cannot be `accepted` or `published` (checked at ingest and by a database trigger on every write).

**Ids.** Every fact, source, section, appendix, block and glossary-entry id, and every
`{fact:…}` reference, must match `^[a-z0-9][a-z0-9-]*$` (lower-case letters, digits and hyphens; no underscore, dot or upper
case), and every block carries an id. A non-matching or missing id is an integrity error and refuses the delivery. It is
checked before the report checker runs, because ids appear inside checker messages.

**Immutability in the database** (migrations 003 and 004). Stored documents cannot be updated, deleted or replaced (an
`INSERT OR REPLACE` aborts on every connection; app connections also run with `recursive_triggers` on); editions cannot be deleted or replaced;
an edition's document, hashes, validation result (with its review findings), pipeline status fields and creation time cannot
change; a new edition must carry its `review_findings` list, all open; and the two dispositions may only move stricter.
Accepting an edition after human review therefore needs a later, explicit review record; it is not built yet.
Overlay ids are never reused after a delete in a store created at schema 5 or later (migration 005, `AUTOINCREMENT`).
An older store upgraded in place cannot know the ids it deleted before the upgrade, so one of those ids can be issued
again and a stale page could address the new overlay. This app supports fresh stores only: start a new `--db` file.

**Status.** The four status fields come from the pipeline's edition status sidecar (`athena-edition-status.v1`, its
`report_sha256` must match the report): `--status-sidecar <file>`, else `EDITION-STATUS.json` in the delivery folder. Flags
such as `--quality-disposition` may only make it stricter. Without a sidecar: delivery incomplete, `unreviewed`, `draft`.
Re-ingesting a stored report never adds an edition. A stricter sidecar or flag tightens the stored dispositions; a looser
sidecar (or the defaults) is ignored, and a looser flag is refused. `delivery_complete` and `native_status` are fixed at first
ingest. The command line prints each tightened or ignored field.

**Live jobs.** The report runner pulls jobs from the app; the app
never calls the runner or a model. Off unless `--jobs-config <json>` (or `ATHENA_JOBS_CONFIG`) names a file with
`"enabled": true`; otherwise every jobs route answers 503 `{"code": "disabled"}` and the rest of the app is unchanged.
Config fields (relative paths are read from the config file's folder; keep the two secret files out of the repository):
`enabled`, `catalog` [{`filing_id`, `issuer`, `form`, `period`, `language`, `accession`, `filing_path`, `checker_path`}],
`access_code_file` (a random code of at least 20 characters), `runner_token_file` (at least 16 characters), `jobs_dir`,
`max_active` (default 1), `max_jobs_per_day` and `max_jobs_total` (both required), `stale_minutes` (default 20),
`claim_timeout_minutes` (default 10), `availability_ttl_seconds` (default 120). A bad config stops the server at start.

*Judge API* (no account). `GET /api/catalog` lists the public fields only. `POST /api/jobs` {`filing_id`, `language`,
`client_request_id`, `client_id`, `access_code`} returns 202 {`job_id`, `state`}. A `client_request_id` belongs to its
`client_id`: the same pair with the same inputs returns the same job, with other inputs 409 `conflict`. Refusals carry a
stable `code` and store no job: `bad_access_code` 403, `unknown_filing` 422, `unavailable` 503 (no fresh `available` report
from the runner) or `cap_reached` 503 (the runner reported its cap, or the app's per-UTC-day or total cap), `rate_limited`
429 (one active job per `client_id`), `busy` 503 (`max_active`). `GET /api/jobs/{job_id}[?after=<seq>]` returns `state`,
timestamps, `last_seq`, `events` (the progress lines with a `seq` above `after`), `edition_id` and `edition_status` (the four
status fields) once ready, `error` ({`code`, `count`} only) and `spend_usd` (null until the runner reports one). States:
`requested`, `claimed`, `running`, `ingesting`, `ready`, `failed`, `refused`, `stopped`, and `unknown`: a claimed, running
or ingesting job with no runner contact for `stale_minutes`. An unknown job keeps counting as active (for `max_active`
and for its browser) and is never handed out again; only its claimant may still report on it, or the operator ends it
(below). A job not claimed within `claim_timeout_minutes`, or whose filing has left the catalog, ends `refused`
(`not_started`, `not_in_catalog`) and is never handed out.

*Runner API.* Every call sends `Authorization: Bearer <token>` (else 401). `POST /api/runner/availability` {`state`
available|disabled|cap_reached, optional `reason`} is the heartbeat; a report is valid for `availability_ttl_seconds`.
`POST /api/runner/claim` {`runner_id`, `claim_request_id` (16-128 characters, kept by the runner before the call)}
returns 200 {`job_id`, `filing_id`, `language`, `claim_token`, `state`} or 204, in one transaction, so a job has one
claimant. The same `claim_request_id` again returns the same job and token (a readback, never a second claim); under
another `runner_id` it is 409 `conflict`. The app stores only the claim token's sha256. A job's own routes need
`X-Claim-Token` (else 403 `bad_claim_token`); `X-Runner-Id` is not used. `GET /api/runner/jobs/{id}` returns the job
with its full `error`, `last_seq` and `operations` [{`operation_id`, `kind`, `completed`}], for readback before a retry.
`POST /api/runner/jobs/{id}/events` takes a list of progress lines (`job_id` of this job, `seq` 1, 2, ... up to 500, `stage` a
slug, `status`, `ts`, optional `note` of at most 200 characters and `spend_usd`, the running total, display only); a repeated
identical line is ignored, another line under a used `seq` is 409 `seq_conflict`, a skipped `seq` 409 `seq_gap`.
`POST /api/runner/jobs/{id}/delivery` takes {`operation_id`, "files": {"REPORT.json": base64, "DELIVERY-MANIFEST.json":
base64, and optionally "EDITION-STATUS.json"}}: at most 4 MiB once decoded (checked on the base64 size before decoding,
413 `too_large`); the request may carry that much only with a valid runner token (every other write keeps 64 KB). The
report must name the job's filing (`filing.accession` = the catalog entry's `accession`) and language, or the job ends
`failed` (`filing_mismatch`, `language_mismatch`), also when the report is already stored. The files are written to
`<jobs_dir>/<job_id>/delivery/` and ingested as above with the catalog entry's filing and checker (the sidecar must
name the report's sha256): `ready` with the edition, or `failed` with the integrity errors and no edition (200 either way;
the details go only to the runner). `POST /api/runner/jobs/{id}/result` {`operation_id`, `outcome` failed|stopped|refused,
`reason`, optional `spend_usd`} ends a run without a delivery. `reason` is one of `cap_reached`, `unavailable`,
`engine_error`, `provider_error`, `timeout`, `input_error`, `stopped`, `operator_closed`, `not_started`,
`not_in_catalog`. A repeated `operation_id` returns the original response; another request under a used one is 409
`operation_conflict`. If the app stops after storing the edition but before ending the job, the job stays `ingesting`
and a repeat of the same delivery operation completes it. A job that is no longer open answers 409 `not_open`.

*Operator command* (local database only; there is no HTTP route): `python -B -m athena_app.jobs_admin [--db athena.db]
[--stale-minutes 20] list` shows active and unknown jobs; `... end <job_id> --reason operator_closed` ends an unknown job
as `failed` (`operator_closed`) and frees its slot. Any other job is refused. Use the server's `stale_minutes`.

**Live Ask.** A reader asks about the open edition; a model answers from
that edition only, with code-checked citations, can drive the Desk (`ui_actions`), and writes only what the reader
approves. Off unless `--ask-config <json>` (or `ATHENA_ASK_CONFIG`) names a file with `"enabled": true`, a model key is
found (`MODEL_API_KEY`, else the file's `key_file`) and a cost cap is set (`ASK_COST_CAP_USD`, else `cost_cap_usd`).
Otherwise the question is saved in the reader's thread and the answer is `disabled` (`live_answers_off`): no network use,
and LangChain is not imported. Install the extra for live use: `pip install '.[ask]'`. Config fields: `enabled`, `model`
(allowlist: `muse-spark-1.3`), `key_file`, `cost_cap_usd`, `base_url` (default `https://api.meta.ai/v1`), `responses_api`
(default false: Chat Completions), `prompt_cache_key` (default true; false sends none, should the service refuse it),
`max_turns` (6 model calls per request), `max_output_tokens` (2048; any whole number, such as 32768: reasoning tokens
count toward it and are billed as output), `reasoning_effort` (left out: nothing is sent and the model picks its level;
else `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, sent as the request's top-level `reasoning_effort`; `none` is a
config error, Muse Spark answers it with HTTP 400), `timeout_seconds` (60), `prices_usd_per_million`
{`input`, `cached_input`, `output`} (1.25, 0.15, 4.25), `agent_db` (default `<db>.ask.sqlite`: LangGraph checkpoints
and the ledger; the App DB schema is unchanged; it may not be the App DB file).
Input and output prices must be above 0. A config error never repeats the file's text. The key is never logged, echoed
or returned. A model id ending `-contributor` is refused for reader content (403 `contributor_refused`), and any id off the
allowlist too (403 `model_not_allowed`), before a model client exists.

`POST /api/editions/{id}/ask` {`question`, `thread_id`?, `intent`?, `anchor_id`?} returns {`state`, `thread_id`,
`answer`, `citations` [{`id`, `kind`, `section_id`}], `numbers` [{`text`, `supported_by`}], `problems`, `ui_actions`,
`pending_actions` [{`id`, `tool`, `args`, `problems`}], `code`, `notice`}. `state`: `answered` (every check passed),
`unverified` (see `problems`), `needs_approval`, `refused` (`outside_filings`: price or advice questions get this without
a model call; the model refuses forecasts and anything the report can't answer), `disabled`. A new question without
`thread_id` starts a thread (an overlay of kind `thread`, mode `ask`); a thread belongs to its reader (another reader gets
404). Quick actions: `intent` is `explain_figure`, `compare_periods` or `define_term`; `anchor_id` is any id of the served
edition (block, fact, glossary entry, source, chapter). The element's served JSON is set ahead of the question, after the
stable prompt prefix (instructions, then the served edition, then the conversation). An unknown intent or anchor, or no
question and no intent, is 400. `POST /api/editions/{id}/ask/{thread_id}/decisions` {`decisions`: [{`id`, `type`
approve|edit|reject, `args` (edit), `message` (reject)}]} decides every pending action at once. Other codes: 409
`pending_actions`, `busy`, `no_pending_actions`; 422 `bad_decisions`; 503 `cost_cap_reached`, `model_busy`; 502
`model_auth_failed` (never retried), `model_error` (also any other failure of the model call, kept without its
words), `model_turn_limit`, `model_output_limit` ("the answer ran out of
room; try a narrower question": the output budget, reasoning included, was used up), `model_content_filter`; 504
`model_timeout`; 500 `ask_failed` (any other failure of a turn: no raw exception leaves either route, and the thread is
free for the next question). A model-side error body also
lists the `ui_actions` of tools that ran before it, and any refusal after the thread exists names its `thread_id` (a new
thread keeps the question). When decisions ran and the model call after them fails (cap reached, 5xx), the approved write
stays stored, the body adds `thread_id` and `notice` ("Your decision was applied and what you approved is saved, but no
answer followed."; without a stored write it does not speak of saved items), its `ui_actions` hold the write's
`overlay_added`, and the thread keeps the decisions plus an assistant record {`code`, `notice`, `ui_actions`}.
Tools: read (`outline`, `read_chapter`, `search_report`, `my_notes`) and view (`open_chapter`, `highlight`,
`open_library`, returned as `ui_actions`) run at once; writes (`add_memo`, `propose_revision`, and `request_report` only
when live jobs are configured: it opens a prefilled New report form, the reader still submits `POST /api/jobs` with the
access code) wait for the reader. A proposed revision is a revision overlay; the edition never changes. There is no tool to
delete, change settings or edit an edition.
*Checks.* Every cited id must exist in the served edition, a `{fact:id}` token must name a fact and a `[src-id]`
reference a source, and every figure written in digits must be supported by a cited element: (a) the element's text
prints it the same way, as digits, `%` or not, and scale (with the printed form, label, period and value of each fact
it shows), or (b) it equals a shown fact's value in whole units, divided by its scale word (thousand, million, billion)
and rounded half up or half even to the decimals the answer prints; a `%` figure equals a ratio x 100 so rounded. The
scale is the word or context right after a figure ("billion", "thousands", "(USD thousands)", "(in thousands)", "(shares
thousands)"); without one, digits equal to the printed form or value of a linked fact (one the element shows, or one
quoted from that source) carry the fact's scale; in a source quote whose linked facts share one scale, every other
comma-grouped, non-`%` amount takes that scale too (the other years' cells); in a filing-table block such amounts take
the scale its heading states (its text before the first row: "(in thousands", "(USD millions", "(Dollars in
thousands", "($ in thousands"; neither a stray phrase such as "shares in millions" nor a footnote after the rows) when it
agrees with its linked facts' (or only one exists), and
otherwise support nothing, never as whole dollars; other digits (years, dates, "1-3 years") have none. A cited amount whose
scale is known also counts for (b). Revenue 4,475,446 USD thousands: "$4.48 billion", "4,475,446 thousand" and
"4,475,446 (USD thousands)" verify; "$4,475,446" (citing the fact or its source src-18), "$4.48 million", "$4,475,446
billion", "$0 trillion" and "2025%" do not; src-23's "1,378,247" (FY2023, no fact of its own) verifies as "$1.38
billion" or "1,378,247 (USD thousands)", not as "$1,378,247". Calculated facts (margins, growth, tax rate) have no
printed form, so "31.6%" verifies only by (b): 0.31595 x 100 = 31.595 rounds to 31.6. Digits inside an identifier in
the report's text ("sep302026") are not figures; FY2025 is still 2025. An amount written in words ("nine billion", "half
a billion", "one third", "sixfold", "thousands of", "in the billions") is never `answered`. Form names (10-K), locators
(Item 8, Note 13), the numbers of an ordered list (1., 2., 3.), the day and month of a date (December 31, 2025-12-31, 12월 31일) and whole lengths of time (the next 12
months, 12개월) are not figures; a fraction ("2.1 years") is. A bare year must be one the report prints somewhere, so a year it
never prints is flagged, and digits with a currency, unit or scale beside them ("$ 2033", "2033억") are an amount, and a year in the cited text supports no amount; the check does not read which line or year a figure is said to belong to. A rounded figure must stay within 5% of the value ("$1" for 0.63 is refused), a figure in another currency is never supported, and "shares" or a dollar mark beside a figure reads only against a fact of that unit. The check covers figures, not direction: "grew" or "fell", signs and comparisons are not checked (so `answered`
means "figures match the cited report").
*Prompt readings.* In the prompt only (never the served or stored edition), each money, share and ratio fact carries a
code-computed `reading` in whole units: 3 significant figures, half even, with thousand, million, billion or trillion
picked by size (`4,475,446 (USD thousands) = $4.48 billion`); a ratio as a percent with one decimal (`0.3159495 (ratio) =
31.6%`). Rule (b) accepts every reading, and the prompt prefix stays the same bytes for every question on an edition.
*Meta Model API.* Tools are sent with `strict: true` (`create_agent` sets it beside a structured response format); every
argument is required and none has a default, so each schema is inside the strict subset. The response format is not
strict. `prompt_cache_key` is `athena-` + 32 hex of sha256 of the stable prefix (instructions and edition): one per
edition and prompt version, no reader data (config `prompt_cache_key: false` leaves it out). Cached input is read
from `usage.prompt_tokens_details.cached_tokens`. `tool_choice` is never sent (auto); parallel tool calls stay on, and
several writes in one turn each wait for a decision.
*Ledger and cost cap* (in the agent file). One row per model call (thread, edition, sha256 of the reader id, model,
input, cached and output tokens from the provider's usage, ceiling, cost, latency, status), per tool call (name, tier,
args sha256, decision, executed) and per answer (state, reason). Cost = ((input - cached) x input price + cached x cached
price + output x output price) / 10^6. Before each call the app holds its ceiling = (UTF-8 bytes of the assembled request x
input price + `max_output_tokens` x output price) / 10^6, and refuses (503 `cost_cap_reached`, no call) unless spent + held
+ ceiling <= the cap. A call settles at its cost when usage is known (also a response cut at the output limit or
filtered, which then refuses as above); a 4xx refusal settles at 0; a timeout, 5xx or missing
usage (a null token count included) stays held at its ceiling. No call is retried. The cap is one budget for the whole server; a per-reader budget is
required before any hosted multi-reader deployment.
*Tracing* is off unless the operator sets `LANGSMITH_TRACING=true` (with `LANGSMITH_PROJECT` and the operator's LangSmith
key); the offline eval is never traced. Traces then carry: the thread's conversation (questions, quick-action lines with the anchored element, answers);
the system prompt (instructions and the served edition with its readings); every tool call and result, including the
reader's own notes from `my_notes` and write-tool arguments (memo text, quotes, revision text); metadata with the
pseudonymous reader id (`r-` + 32 hex of sha256 of the cookie, in the thread id `<reader>:<edition>:<thread>`); the model
name and the API base URL; errors (type and HTTP status; a provider's message only with the key and any bearer token
masked). Runs go through a LangSmith client whose anonymizer replaces the configured model key, any run of 12 or more of
its consecutive characters (a truncated echo) and any `Bearer <token>` before upload. Never sent: the model key, an
Authorization header or bearer token, the raw reader cookie, access codes or runner tokens, and the App DB or agent DB files.
*Eval* (`athena_app/ask_eval.py`): `python -B -m athena_app.ask_eval [--questions ../eval/ask-faq-r14.json] --db athena.db
--edition 1 --out results.json [--live]`. Without `--live` a dry-run fake answers on a temporary copy of the DB (no network,
the given files untouched); `--live` uses the config above under the cap. Writes are never approved. The run stops at
the first outcome other than `answered`, `unverified`, `refused`, `needs_approval` or `model_turn_limit` (any other code
or HTTP status; later questions are `not_run` and `totals.stopped_by` names it). The results file is created new, never
overwritten, and is written also when the run stops or a question fails in the runner.

*Fake runner* (no model call, no spend; for UI work and demos): `python -B -m athena_app.fake_runner --app
http://127.0.0.1:8000 --token-file <file> [--delay 2] [--wait 0]` reports itself available (every 30 s while it runs),
claims one job, posts six progress lines and delivers `fixtures/r14`, a draft, review-required edition.
`--state disabled|cap_reached` only reports that availability. Plain `http://` is refused except to a loopback host.
