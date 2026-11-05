"""Inline the report data into the prototype.

Usage: python -I -B build.py

Reads src/shell.html, inlines src/app.css and src/app.js, fills the one data block and writes
prototype.html (one self-contained file; fonts load from fonts/ next to it).
Data: ../content/report_v3.json.
"""
import hashlib
import json
import pathlib
import sys

UI = pathlib.Path(__file__).resolve().parent
W = UI.parent
REAL = W / "content" / "report_v3.json"
SRC = UI / "src"
OUT = UI / "prototype.html"
MARK = '<script type="application/json" id="report-data"></script>'

# the 13 chapters: (id, title, question)
CHAPTERS = [
    ("business", "Business", "How does the company make money?"),
    ("scorecard", "Scorecard", "What changed over three years?"),
    ("profitability", "Profitability", "What remains from every dollar of revenue?"),
    ("segments", "Segments", "Which customers drive the growth?"),
    ("earnings-quality", "Earnings quality", "How much of net income is the core business?"),
    ("cash-flow", "Cash flow", "How much cash did the year really produce?"),
    ("investment", "Investment", "Where is the company putting its capital?"),
    ("balance-sheet", "Balance sheet", "What does the balance sheet rest on?"),
    ("shareholders", "Shareholders", "What changed for each share?"),
    ("demand", "Demand", "How much future revenue is already contracted?"),
    ("risks", "Risks", "What could change the story?"),
    ("valuation", "Valuation lab", "What does a price you choose imply?"),
    ("watchlist", "Watchlist", "What should the next filing confirm?"),
]


def main():
    data, origin = json.loads(REAL.read_text()), str(REAL)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    src = (SRC / "shell.html").read_text()
    if src.count(MARK) != 1 or src.count("/*APP_CSS*/") != 1 or src.count("/*APP_JS*/") != 1:
        sys.exit("src/shell.html must contain the empty data block, /*APP_CSS*/ and /*APP_JS*/ exactly once")
    src = src.replace("/*APP_CSS*/", (SRC / "app.css").read_text()).replace("/*APP_JS*/", (SRC / "app.js").read_text())
    OUT.write_text(src.replace(MARK, MARK.replace("></script>", ">" + raw + "</script>")))
    print(f"data: {origin}")
    print(f"facts {len(data['facts'])} · sections {len(data['sections'])} · sources {len(data['sources'])}")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sha256 {hashlib.sha256(OUT.read_bytes()).hexdigest()})")


if __name__ == "__main__":
    main()
