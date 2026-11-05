# Athena AI Finance

The Financial Report microservice of Athena AI, a Trade Matrix Labs project. Finance is the service in this
repository; other Athena AI services can sit beside it.

It turns a company's annual report (a Form 10-K filed with the SEC) into a structured, readable
report whose structured figures are linked back to the exact place in the filing they come from. This
repository holds the demo app: a small local server that takes in a finished report, checks that each linked
figure traces to a record, each quote to the filing and each shown value to its quote, stores it as an immutable edition and shows it in the reading UI, where each
reader can keep private memos next to it.

> **Status: HOLD · draft · review required.** The sample report in this repository is an assisted
> revision (n=1), not an accepted report. Financial review failed — correction required. The app
> shows it as "Draft · review required". It is a technology demo, not investment advice.

## Demo video

3-minute demo: https://youtu.be/Ugn7Gb7mqrc

## What was built for this hackathon

Meta Global AI Developer Hackathon, Startup track, problem statement "Build for Your World".

**Built during the hackathon (26 Oct to 4 Nov 2026), all in this repository:**

- The reading app (`ui/`), started from the mockups listed below: figures linked to the filing, the Probe, the side tab, See Through, Conversation and Library.
- The local server and specialized database (SQLite, `app/`): code checks at ingest, stored editions, and each reader's private memos and threads.
- Ask (`app/athena_app/ask.py`, `ask_agent.py`): a LangChain agent on Muse Spark 1.3 through the Meta Model API. It cites the passages it used, checks its numbers against them, and waits for approval before any change.
- The number checker (`content/`) and the Ask evaluation (`eval/`, `app/athena_app/ask_eval.py`).
- The sample report (`app/fixtures/r14/`): an assisted revision made on 1 Nov 2026 with the private engine, included as demo data.

**Started before the hackathon:**

- A private draft of the report engine (late September 2026), in research and testing to see whether it was worth developing. It made sample reports, none publishable. During the hackathon we developed it on Meta's Muse models. It is not in this repository.
- Reading-desk mockups (20 Oct 2026). The reading app started from their ideas, such as memos, Ask, suggested edits and the Probe, and reuses some of their code.

## Run it

You need Python 3.12 or newer.

```
pip install fastapi uvicorn
cd app
python -B -m athena_app.ingest fixtures/r14 --db athena.db \
    --ui ../ui --checker ../content/check_report.py --filing ../inputs/pltr-20251231.htm
python -B -m athena_app.server --db athena.db --ui ../ui --port 8000
```

Then open http://127.0.0.1:8000/ in a browser. Stop the server with Ctrl+C.

Tests (from `app/`):

```
pip install '.[test,ask]'
python -B -m pytest -q
```

The tests include the optional Ask feature (below), so they need its extra too. They use fake models and make no
model call.

The number checker on its own (from `content/`): `python -I -B check_report.py` checks the
structured figures of `report_v3.json` against the filing (inline XBRL tags where a fact names one, otherwise its quoted text) and prints the mismatch count; `--selftest` alters five
figures and shows that each one is caught.

`ui/prototype.html` is a static build of the same UI with the sample data inlined; it opens directly
in a browser, with no server.

## Ask (optional)

Ask lets a reader put a question to the open edition. A model answers from that edition only, with citations
that the app checks against the edition (every cited id must exist and every figure written in digits must be
supported by a cited element). Ask can also drive the reading UI (open a chapter, highlight a passage) and can
propose a memo or a revision, but it writes only what the reader approves; the edition itself never changes.

Ask is off by default, and the demo above needs no key. Without it, a question is saved in the reader's thread,
the answer is `disabled`, nothing leaves your machine, and LangChain is not even imported. In the app, the suggested
questions show pre-written sample answers, with no model call. To enable live answers:

1. Install the extra (from `app/`): `pip install '.[ask]'`.
2. Write your own config file, kept outside this repository, with `"enabled": true`, `"model": "muse-spark-1.3"`,
   `"cost_cap_usd"` (a spending cap you choose) and `"key_file"`, the path of a file that holds your own Meta API
   key. The key is read from that path (or from the `MODEL_API_KEY` environment variable); never commit it.
3. Start the server with `--ask-config <your-config.json>` (or set `ATHENA_ASK_CONFIG`).

Reader questions use the standard Muse Spark 1.3 route only: any other model id is refused before a model client
is created. `app/README.md` lists every option and error code. `eval/` holds a fixture of 24 reader questions
about the sample report (`ask-faq-r14.json`) and `check_faq.py`, an offline check of that fixture
(`python -I -B check_faq.py`, standard library only).

## What is real and what is a sample

| Part | What it is |
|---|---|
| `inputs/pltr-20251231.htm` | Real: Palantir Technologies Inc.'s Form 10-K for fiscal 2025, as filed with the SEC (public data). |
| `app/` | Real, working code: ingest with hash checks, the reference check, an immutable SQLite store, the API and private memos, and a jobs API through which a report runner requests, claims and delivers a report. `athena_app.fake_runner` drives that API for demos with the sample report; it makes no model call. |
| `content/check_report.py` | Real, working code: checks structured figures against the filing's inline XBRL tags where a fact names one, otherwise against its quoted text, using only the Python standard library. |
| `app/fixtures/r14/REPORT.json` | A sample: one pre-generated report (an assisted revision), used as the app's fixture. HOLD, draft, review required; financial review failed — correction required; it ingests with 23 open review findings. |
| `app/fixtures/s1/` | A synthetic one-chapter delivery (Profitability only), not model output and not a report. It tests that an edition holding 1 of 13 chapters reads as partial everywhere. |
| `content/report_v3.json` | A sample: the report data shown by the static UI build. Its figures check against the filing; all of its prose is sample AI text. It is a draft that has not passed review. |
| `app/athena_app/ask.py`, `ask_agent.py` | Real, working code: the optional Ask feature above. Off by default; the tests drive it with fake models. |
| Library, "New report", other companies, answers | Sample screens in the UI. This repository does not generate reports. |
| Languages | English for now. Korean, German, Japanese, French, Chinese and Spanish are planned. |

## How reports are made

An agent pipeline built on Meta's model API reads a public filing and turns it into a structured
report: chapters, figures, calculations and the filing quotes they rest on. Public filing research runs on Muse Spark 1.3 Contributor; reader questions never reach
it. That pipeline is not part of this repository. This app starts where the pipeline ends: it ingests the finished report, checks reference
integrity (each linked figure traces to a record, each quote to the filing and each shown value to its quote), refuses a report that fails, and stores each
delivery that passes as an immutable edition. These checks do not by themselves establish that every extraction and calculation is right, and a number typed directly into the prose or a heading is not checked. Smaller issues, such as an over-long quote, are kept as
open review findings, and an edition with open findings cannot be marked accepted or published. Readers add private memos on top; the shared edition never
changes.

## Licence

Apache License 2.0, see [LICENSE](LICENSE). Copyright 2026 Trade Matrix Labs. The licence grants no
right to use the "Athena" name. Third-party material (the fonts, under the SIL Open Font License 1.1,
and the SEC filing) is listed in [NOTICE](NOTICE).
