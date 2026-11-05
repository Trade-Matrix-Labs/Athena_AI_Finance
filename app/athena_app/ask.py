"""Ask: a reader's question about the served edition, answered by a model from that
edition only, with code-checked citations, reader-approved writes and a cost ledger.

Off unless --ask-config (ATHENA_ASK_CONFIG) names a file with "enabled": true, a model key is found (MODEL_API_KEY,
else the file's key_file) and a cost cap is set (ASK_COST_CAP_USD, else the file's cost_cap_usd). Otherwise a question
is saved in the reader's thread, the answer is `disabled` and the Desk keeps its sample answers: no network use at all,
and LangChain is never imported.

Config keys: enabled, model, key_file, cost_cap_usd, base_url (https://api.meta.ai/v1), responses_api (false),
prompt_cache_key (true: one per edition; false if the service refuses it), max_turns (6), max_output_tokens (2048;
reasoning tokens count toward it), reasoning_effort (unset: the model picks; else minimal, low, medium, high, xhigh or
max, sent as the request's reasoning_effort), timeout_seconds (60), prices_usd_per_million {input, cached_input,
output} (1.25, 0.15, 4.25; input and output above 0), agent_db (next to the App DB: <db>.ask.sqlite; never the App DB
itself).
Relative paths are read from the file's folder.
The agent file holds the LangGraph checkpoints and the ledger; the App DB schema is unchanged.
"""
import contextlib
import decimal
import hashlib
import json
import logging
import os
import pathlib
import re
import sqlite3
import threading
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal
from typing import Annotated, Any, Literal

from fastapi import FastAPI, HTTPException, Path, Request
from pydantic import BaseModel, Field, SecretStr

from . import store
from .adapter import SCALE_EXP, TOKEN
from .jobs import ConfigError, Refusal

ALLOWED_MODELS = {"muse-spark-1.3"}  # Standard mode; the model id chooses the mode on Meta Model API
BASE_URL = "https://api.meta.ai/v1"
PRICES = {"input": 1.25, "cached_input": 0.15, "output": 4.25}  # USD per 1M tokens, Muse Spark Standard
INTS = {"max_turns": 6, "max_output_tokens": 2048, "timeout_seconds": 60}
ASK_FAILED = (500, "ask_failed", "the answer could not be completed; try again")  # any unmapped failure of a turn
LOG = logging.getLogger(__name__)
REASONING = ("minimal", "low", "medium", "high", "xhigh", "max")  # Muse Spark's levels; "none" is an HTTP 400
KEYS = {"enabled", "model", "key_file", "cost_cap_usd", "base_url", "responses_api", "prompt_cache_key",
        "reasoning_effort", "prices_usd_per_million", "agent_db", *INTS}
Id = Annotated[int, Path(ge=1, le=2**63 - 1)]
SRC_REF = re.compile(r"\[(src-[a-z0-9-]+)\]")
# a figure in prose: digits with optional thousands commas and decimals, then an optional % and an optional scale:
# a word ("billion", "thousands", "억") or a context ("(USD thousands)", "(in thousands)", "(shares thousands)"). _L and _R
# stand in for \b, which fails beside Korean ("10-K에", "4.48 billion입니다"): Hangul counts as a word character
_L, _R = r"(?<![A-Za-z0-9])", r"(?![A-Za-z0-9])"
_GAP = "[\\s\\-‐‑−–—\u200b\u2060\ufeff\u00ad]*"  # between digits and their unit: "2033-million", and the spaces bold marks leave ("**2033** million")
_PCT = (rf"[%％]|percent{_R}|per cent{_R}|pct{_R}|percentage\s+points?{_R}|pp{_R}(?!&)"
        r"|퍼센트|포인트|프로(?![젝그세필모토덕듀파바포])")
_NOT_FY = r"(?<!FY\d{4})(?<!FY \d{4})"  # digits right after FY are a year: what follows is a word ("FY2024만 비교합니다", "FY2024 pp")
_FIG = rf"(\d{{1,3}}(?:,\d{{3}})+|\d+)(\.\d+)?(?:{_NOT_FY}{_GAP}({_PCT}))?"
# a Korean scale or unit also starts ordinary words (조정, 주요, 원가율, 만기, 천연가스). Glued to the digits it is always the scale
# or unit, whatever ending follows ("0.63억인", "2025원이었습니다"). After a space it is one unless the next syllable names such a
# word. The list names the words, not the endings: an unlisted ending must read as a scale, since one left unread would show
# the bare digits as checked, while a word read as a scale only costs a "couldn't be checked" note
_EOK, _JO = "억(?!제|측|지)", "조(?!정|건|사|직|달(?!러)|항|치|합|세|기|회|성|약|절|작|언|선)"
_KSCALE = (rf"(?<=\d)(?:[십백천]?[만억조]|[백천])|[십백천]?(?:만(?!기|료|큼|족|든|들|약|일|나)|{_EOK}"
           rf"|{_JO})|천(?!연|재|장|문)|백(?!분|서|신|화|악)|[十百千]?[万萬億亿兆]|千|[밀빌]리언|트릴리언")
_WORD = (rf"(?:hundred|thousand|lakh|million|crore|billion|trillion)s?{_R}|(?:bn|bln|bil|mn|mln|mil|tn|trn|mm|[kmbt]){_R}"
         rf"|(?:basis\s+points?|bps?){_R}|cents?{_R}|[¢‰]|센트|{_KSCALE}")
NUMBER = re.compile(rf"{_FIG}(?:{_NOT_FY}{_GAP}(?:(?:USD|US\s+dollars?|dollars?){_R}{_GAP})?({_WORD}|\((?:in |usd |shares )?(?:thousand|million|billion)s?\)))?", re.I)
EMPHASIS = re.compile(r"[*`_]+|(?<![\d\s])~+|~+(?![\d\s])")
# digits that are no reported amount, so an answer's check skips them. Each form is narrow on purpose, since a figure wrongly
# skipped shows as checked, while a harmless number left in only costs a "couldn't be checked" note: form names (10-K),
# quarters (Q4), a locator with a one- or two-digit number (Item 7A, Note 13), the day and month of a date (December 31, 2025,
# 2025-12-31, 12/31/2025, 31 December 2025, 12월 31일) and a whole length of time ("the next 12 months", a 12-month period,
# 12개월, "13 to 36 months"; "2.1 years" can be a reported figure). A % or a scale after a locator makes it an amount. The year of a date stays in
# the text for YEAR
_FOREIGN = "KRW|EUR|GBP|JPY|CNY|RMB|CHF|AUD|CAD|HKD|SGD|INR|TWD|NZD|MXN|BRL|RUB|SEK"
_MONEY = f"USD|{_FOREIGN}"
_ABROAD = (r"(?:(?:South\s+)?Korean\s+|Japanese\s+|Chinese\s+|Indian\s+|Swiss\s+|British\s+)?"
           r"(?:won|yen|yuan|renminbi|euros?|pounds?|francs?|rupees?|pence|pesos?|rubles?|baht|lira|kronor)"
           r"|(?:Canadian|Australian|Hong\s+Kong|(?:New\s+)?Taiwan|Singapore|New\s+Zealand)\s+dollars?")
_KABROAD = r"(?:캐나다|호주|홍콩|대만|싱가포르|뉴질랜드)\s*달러|유로화?|위안화?|파운드|루피|펜스|페소|루블|바트|프랑(?!스)|링깃|元|円"
# every Unicode currency sign (category Sc) but the dollar's ($ ＄ ﹩) and the cent's (¢, a scale word)
_SIGNS = "\u00a3-\u00a5\u058f\u060b\u07fe\u07ff\u09f2\u09f3\u09fb\u0af1\u0bf9\u0e3f\u17db\u20a0-\u20cf\ua838\ufdfc\uffe0\uffe1\uffe5\uffe6\U00011fdd-\U00011fe0\U0001e2ff\U0001ecb0"
_UNIT = rf"(?:{_MONEY}|{_ABROAD}|dollars?|cents?|shares|per\s+share){_R}|달러|{_KABROAD}|[{_SIGNS}]"
TOKEN_SCALED = re.compile(rf"[$＄﹩{_SIGNS}]\s*\{{fact:|\{{fact:[^}}]+\}}\s*(?:(?:hundred|thousand|million|billion|trillion|bn|mn)s?(?![A-Za-z0-9])|[%％]|{_EOK}|{_JO}|달러)", re.I)
_MONTH = (r"(?-i:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?"
          r"|Nov(?:ember)?|Dec(?:ember)?)\.?")
_AMOUNT = rf"[.,]\d|{_GAP}(?:{_PCT}|{_WORD}|{_UNIT}|\((?:in |usd |shares )?(?:thousand|million|billion)s?\))"
_NO_AMOUNT = rf"(?!{_AMOUNT})"
_TIME = "(?:day|week|month|year|quarter)"
_DAY = r"(?:[12]?\d|3[01])"
NOT_FIGURE = re.compile(rf"{_L}(?:10[-‐‑][KQ]|8[-‐‑]K|20[-‐‑]F|13[-‐‑]?F){_R}|{_L}Q[1-4]{_R}"
                        rf"|{_L}items?\s+\d{{1,2}}(?-i:[A-C])?{_R}{_NO_AMOUNT}|{_L}(?:note|part|section)s?\s+\d{{1,2}}{_R}{_NO_AMOUNT}"
                        rf"|{_L}{_MONTH}\s+{_DAY}{_R}(?![.,]\d)(?=,?\s+\d{{4}}{_R}|\s*[,.;:)\]]|\s*$)"
                        rf"|(?<=\b[12]\d{{3}}-)(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)"
                        rf"|(?<![\d/.,])(?:0?[1-9]|1[0-2])/{_DAY}/(?=\d{{4}}{_R})"
                        rf"|(?<![\d.,$]){_DAY}\s+(?={_MONTH}\s+\d{{4}}{_R})"
                        rf"|(?<![A-Za-z0-9.,$＄﹩{_SIGNS}])(?:\d{{1,2}}-{_TIME}{_R}(?!-end)|\d{{1,2}}\s{_TIME}s{_R}|1\s{_TIME}{_R}"
                        rf"|\d{{1,2}}(?=(?:\s+to\s+|\s*[-–—～~]\s*)\d{{1,2}}(?:\s{_TIME}s{_R}|\s?(?:개월|분기|년)))"
                        rf"|\d{{1,2}}(?:월|일|년|\s?(?:개월|분기)))", re.I)
LIST_ITEM = re.compile(r"^\s*(\d{1,2})[.)](?=\s)", re.M)
# a year in an answer ("FY2024", "through 2033") is a date label, not an amount: it must be a year the report prints, anywhere
# in it, not one in the cited text. A year the report never prints stays unmatched; the check still does not read which year a
# figure is said to belong to. A currency or unit beside the digits makes them an amount ("$ 2033", "2033달러", "2033 shares"),
# unless the words before them make it a date ("FY2024엔", "In 2024 shares rose")
YEAR = re.compile(r"(?<![\d,.])(?:19|20)\d{2}(?![\d,.]\d)")
MONEY_BEFORE = re.compile(rf"(?:[$＄﹩{_SIGNS}]|{_L}(?:{_MONEY}|dollars?|미화))\s*\(?\s*$", re.I)
_WON = "원(?!가(?!량)|재|인|칙|천|화|래|금|본|유|자|활|격|달|료)"
_YEN = "엔(?!진|터|비|화|지)"
# a countable noun reads as a date after "the" or "for" ("the 2024 contracts", "For 2025 customers grew"), and a singular one always
UNIT_AFTER = re.compile(rf"{_GAP}(?:{_UNIT})|(?<!the \d{{4}})(?<!for \d{{4}}){_GAP}(?:employees|customers|clients|people|contracts|times){_R}|[원엔주명불개건배]"
                        rf"|\s+(?:{_WON}|주(?!당|요|주|식|가|로|의|장|된|력|문|목|택|제|체|간|기|석)|명(?!세|시|목|확|칭|단|의|성|백|령)|{_YEN})", re.I)
# what a figure's neighbours say it counts. Every report so far is a USD filing, so another currency beside a figure is never
# supported ("45억 원", "€4.48 billion"); shares and dollars only read against a fact of that unit.
# one currency; a foreign filer needs the fact's own currency compared here
ABROAD_BEFORE = re.compile(rf"(?:[{_SIGNS}]|{_L}(?!US)[A-Z]{{1,3}}[$＄﹩]|{_L}(?:{_FOREIGN}|{_ABROAD})|원화|엔화|{_KABROAD})\s*\(?\s*$", re.I)
ABROAD_AFTER = re.compile(rf"{_GAP}\(?(?:(?:{_FOREIGN}|{_ABROAD}|cents?){_R}|원화|엔화|{_KABROAD}|센트|[¢{_SIGNS}])|[원엔]|\s+(?:{_WON}|{_YEN})", re.I)
SHARES_AFTER = re.compile(rf"{_GAP}(?:shares{_R}|주(?![당요주식가로의장된력문목택제체간기석]))", re.I)  # "share" alone is no unit: "a $1.0 billion share repurchase", "a 38% share"
SCALE_AFTER = re.compile(rf"{_GAP}(?:{_WORD})", re.I)
DOLLARS_BESIDE = re.compile(rf"{_GAP}(?:(?:USD|dollars?){_R}|달러|불|[$＄﹩])", re.I)
UNITS = {"shares": ("shares",), "dollars": ("usd", "usd_per_share")}
DATE_BEFORE = re.compile(rf"(?:{_L}(?:in|during|since|through|until|after|before)\s+|FY\s?)$", re.I)
# in element text: not digits inside an identifier ("sep302026", "v2.1", "Q4"; FY2025 still gives 2025), and a
# context such as "(in thousands)" is a table's heading, not the scale of the date before it (see STATED). An answer's
# figures are read with NUMBER, so a glued figure ("USD4.48 billion") is still checked.
PRINTED = re.compile(rf"(?:(?<=FY)|(?<![\w.,])){_FIG}(?:\s?({_WORD}))?", re.I)
# a filing table's stated scale: a parenthesised heading ("(in millions", "(Dollars in thousands", "($ in thousands")
STATED = re.compile(r"\((?:dollars\s+|\$\s*)?(?:in|usd|shares)\s+(thousand|million|billion)s?\b", re.I)
SCALE_WORDS = {"thousand": 3, "k": 3, "million": 6, "mn": 6, "mln": 6, "mil": 6, "m": 6, "billion": 9, "bn": 9, "bln": 9, "bil": 9,
               "b": 9, "trillion": 12, "tn": 12, "trn": 12, "t": 12, "mm": 6, "hundred": 2, "lakh": 5, "crore": 7, "백": 2, "천": 3, "千": 3, "밀리언": 6, "빌리언": 9, "트릴리언": 12,
               "bp": -4, "point": -4, "‰": -3,  # a rate of another size: 38 bps is 0.0038, so only a ratio's value supports it
               "cent": -2, "¢": -2, "센트": -2,  # 63 cents is 0.63, so only a per-share amount supports it
               **{a + b: i + j for a, i in (("", 0), ("십", 1), ("백", 2), ("천", 3), ("十", 1), ("百", 2), ("千", 3))
                  for b, j in (("만", 4), ("억", 8), ("조", 12), ("万", 4), ("萬", 4), ("億", 8), ("亿", 8), ("兆", 12))}}
# an amount written in words ("nine billion", "half a million", "twenty percent", "one third", "sixfold", "thousands
# of", "in the billions"): never verified. "A third party" is not one.
_W = (r"(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|"
      r"seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half|few|several|dozen)")
_S = "[\\s\\-‐‑−–—]"
_KN = "[일이삼사오육칠팔구십백천]"
_ODD = "[²³¹⁰⁴-⁹₀-₉①-⑳⑴-⒇Ⅰ-ↈ❶-➓]"  # digits Python's \\d does not read: an amount beside a unit or scale, else a list mark or footnote ("① 매출은", "R²")
SPELLED = re.compile(rf"{_L}(?!(?:an?|one){_S}+dollar{_R}|(?:a{_S}+)?few{_S}+dollars{_R}){_W}(?:{_S}+{_W})*{_S}+(?:hundred|thousand|million|billion|trillion|bn|mn|tn|dollars?|cents?|percent|per cent|"
                     rf"thirds?{_R}(?!{_S}+part)|quarters?|fifths?|tenths?){_R}"
                     rf"|{_L}{_W}(?:{_S}+{_W})*\s*[%％]"
                     rf"|{_L}{_W}(?:{_S}+{_W})*-?fold{_R}"
                     rf"|{_L}{_W}\s+(?:in|out\s+of)\s+(?:ten|twenty|a\s+hundred|one\s+hundred){_R}"
                     rf"|{_L}multi{_S}?(?:million|billion|trillion){_R}"
                     rf"|{_L}(?:in the (?:hundreds|thousands|millions|billions|trillions)|"
                     rf"(?:hundreds|thousands|millions|billions|trillions|dozens) of){_R}"
                     rf"|(?<!\d)(?<!\d\s)(?:{_KN}+|수|몇)[십백천]?\s?[만억조]\s?(?:달러|불|원|엔|유로|위안|주|명)"
                     r"|[一二三四五六七八九十百千两兩]+[万萬亿億兆]*(?:美元|日元|欧元|韩元|元)"
                     rf"|(?<=[$＄﹩{_SIGNS}]){_ODD}|{_ODD}+(?={_AMOUNT})", re.I)
ROUNDING = Decimal("0.05")  # a rounded figure stays within 5% of the value: "$1" for 0.63 rounds, but says something else
READ_UNITS = {"usd": "USD", "shares": "shares", "usd_per_share": "USD per share"}  # facts the prompt gives a reading
READ_WORDS = ((12, "trillion"), (9, "billion"), (6, "million"), (3, "thousand"))
SKIP_KEYS = {"id", "kind", "tone", "accession", "filing_accession", "formula", "inputs", "source", "unit", "scale",
             "table", "tag", "table_ref", "format", "basis",  # these four are ids too: "st-30 t-289" reads as 30 trillion
             "native_label"}  # the filing's own row label: "+ 4 more" is no amount
# price and advice questions get the calm refusal with no model call. Anything else, forecasts included, goes to the
# model, whose rule 2 refuses it (cant_answer). Narrower than the Desk's PRICE_Q/OUT_Q (ui/src/app.js), which also
# refuse "compare it with next year's report" (FAQ item faq-22, a write request) and "market value of securities".
ADVICE_Q = re.compile(r"\b(share price|stock price|price today|today's price|market cap(italization)?|trading at|"
                      r"price target|target price|should i (buy|sell|hold)|buy or sell|worth buying|undervalued|"
                      r"overvalued)\b", re.I)
OFF_NOTICE = "Live answers are not enabled. Your words were not sent to a model."
LEDGER_SQL = """
CREATE TABLE IF NOT EXISTS ask_model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, thread_id INTEGER,
  edition_id INTEGER, reader_sha256 TEXT, model TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
  ceiling_usd REAL NOT NULL, cost_usd REAL, latency_ms INTEGER, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ask_tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, thread_id INTEGER,
  edition_id INTEGER, reader_sha256 TEXT, tool TEXT NOT NULL, tier TEXT NOT NULL, args_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL, executed INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ask_answers (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, thread_id INTEGER,
  edition_id INTEGER, reader_sha256 TEXT, state TEXT NOT NULL, reason TEXT);
"""
HELD = ("held", "unknown")  # rows that count at their ceiling: in flight, or an outcome that is not known


class CostCapReached(Exception):
    pass


# ---- config ----

def load_config(path, db_path):
    """The live Ask settings, or None (keyless: today's behaviour). The key is kept as a SecretStr, never printed."""
    if not path:
        return None
    if isinstance(path, dict):  # already loaded (ask_eval's offline run)
        return path
    path = pathlib.Path(path)
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict) or set(raw) - KEYS:  # the file's text is never echoed: it may hold a pasted key
        raise ConfigError(f"ask config: a JSON object with only these keys: {', '.join(sorted(KEYS))}")
    if raw.get("enabled", False) is not True:
        return None
    key = os.environ.get("MODEL_API_KEY", "").strip()
    if not key and raw.get("key_file"):
        kf = path.parent / raw["key_file"]
        if not kf.is_file():
            raise ConfigError("ask config: key_file is not a file")
        key = kf.read_text().strip()
    cap = os.environ.get("ASK_COST_CAP_USD", raw.get("cost_cap_usd"))
    if not key or cap in (None, ""):  # no key, or no cost cap: live calls stay off
        return None
    try:
        cap = float(cap)
    except ValueError:
        raise ConfigError("ask config: the cost cap must be a number of USD") from None
    if not 0 < cap < 1e6:
        raise ConfigError("ask config: the cost cap must be above 0")
    cfg = {"model": raw.get("model"), "key": SecretStr(key), "cap_usd": cap, "base_url": raw.get("base_url", BASE_URL),
           "responses_api": raw.get("responses_api", False), "prompt_cache_key": raw.get("prompt_cache_key", True),
           "reasoning_effort": raw.get("reasoning_effort"), "prices": PRICES | raw.get("prices_usd_per_million", {})}
    if not isinstance(cfg["model"], str) or not cfg["model"]:
        raise ConfigError("ask config: model is required")
    if not re.match(r"https://|http://(127\.0\.0\.1|localhost)[:/]", cfg["base_url"]):
        raise ConfigError("ask config: base_url must be https (plain http only to a loopback host)")
    if type(cfg["prompt_cache_key"]) is not bool:
        raise ConfigError("ask config: prompt_cache_key must be true or false")
    if cfg["reasoning_effort"] is not None and cfg["reasoning_effort"] not in REASONING:
        raise ConfigError(f"ask config: reasoning_effort must be one of {', '.join(REASONING)} (or left out); "
                          "none is refused by Muse Spark")
    if type(cfg["responses_api"]) is not bool or set(cfg["prices"]) != set(PRICES) \
            or not all(type(v) in (int, float) and v >= 0 for v in cfg["prices"].values()) \
            or not cfg["prices"]["input"] > 0 < cfg["prices"]["output"]:
        raise ConfigError("ask config: responses_api must be true or false; prices need input and output above 0 "
                          "and cached_input at least 0")
    for k, default in INTS.items():
        if type(v := raw.get(k, default)) is not int or v < 1:
            raise ConfigError(f"ask config: {k} must be a whole number of at least 1")
        cfg[k] = v
    cfg["agent_db"] = path.parent / raw["agent_db"] if raw.get("agent_db") else pathlib.Path(f"{db_path}.ask.sqlite")
    if pathlib.Path(cfg["agent_db"]).resolve() == pathlib.Path(db_path).resolve():
        raise ConfigError("ask config: agent_db must be a file of its own, not the App DB")
    return cfg


def check_route(model, origin="reader"):
    """At model dispatch: reader content never goes to a Contributor route (on Meta Model API the model id picks
    the mode: `muse-spark-1.3` Standard, `muse-spark-1.3-contributor` Contributor), and only allowlisted ids are used.
    Called before every model client is made, for every Ask and decisions request (history, tools and notes included)."""
    if origin == "reader" and model.endswith("-contributor"):
        raise Refusal(403, "contributor_refused", "reader content is never sent to a Contributor-mode model")
    if model not in ALLOWED_MODELS:
        raise Refusal(403, "model_not_allowed", "this model id is not on the server's allowlist")


def chat_model(cfg, **extra):
    """The model client: no retries at all (a 4xx is never retried; an unknown outcome stays held, see the ledger)."""
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=cfg["model"], base_url=cfg["base_url"], api_key=cfg["key"], max_retries=0,
                      max_tokens=cfg["max_output_tokens"], timeout=cfg["timeout_seconds"],
                      use_responses_api=cfg["responses_api"],
                      **({"reasoning_effort": cfg["reasoning_effort"]} if cfg.get("reasoning_effort") else {}), **extra)


# ---- ledger and cost cap (in the agent file, never the App DB) ----

def ledger(path):
    conn = sqlite3.connect(path, isolation_level=None, timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_ledger(path):
    with contextlib.closing(ledger(path)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(LEDGER_SQL)


def cost(prices, input_tokens, cached_tokens, output_tokens):
    """USD = ((input - cached) * p_input + cached * p_cached_input + output * p_output) / 1e6."""
    return ((input_tokens - cached_tokens) * prices["input"] + cached_tokens * prices["cached_input"]
            + output_tokens * prices["output"]) / 1e6


def ceiling(prices, request_bytes, max_output_tokens):
    """The most one call can cost: every UTF-8 byte of the serialized request counted as one uncached input token (a
    token covers at least one byte), plus the output limit."""
    return (request_bytes * prices["input"] + max_output_tokens * prices["output"]) / 1e6


def hold(path, cap, row):
    """Reserve one call at its ceiling, or refuse (CostCapReached) without a call: spent + held + this ceiling <= cap.
    The check and the reservation are one write transaction, so concurrent requests cannot both pass."""
    with contextlib.closing(ledger(path)) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            used = conn.execute("SELECT coalesce(sum(CASE WHEN status IN ('held', 'unknown') THEN ceiling_usd"
                                " ELSE cost_usd END), 0) FROM ask_model_calls").fetchone()[0]
            if used + row["ceiling_usd"] > cap:
                raise CostCapReached(used)
            cur = conn.execute(f"INSERT INTO ask_model_calls ({', '.join(row)}, at, status) VALUES "
                               f"({', '.join('?' * len(row))}, ?, 'held')", [*row.values(), store.now()])
            conn.execute("COMMIT")
            return cur.lastrowid
        except BaseException:
            conn.execute("ROLLBACK")
            raise


def settle(path, call_id, status, **fields):
    """A known outcome replaces the hold (status ok: actual cost; rejected: 0). An unknown one stays at its ceiling."""
    with contextlib.closing(ledger(path)) as conn:
        sets = {"status": status, **fields}
        conn.execute(f"UPDATE ask_model_calls SET {', '.join(k + ' = ?' for k in sets)} WHERE id = ?",
                     [*sets.values(), call_id])


def record(path, table, row):
    with contextlib.closing(ledger(path)) as conn:
        conn.execute(f"INSERT INTO {table} ({', '.join(row)}, at) VALUES ({', '.join('?' * len(row))}, ?)",
                     [*row.values(), store.now()])


def digest(o):
    return hashlib.sha256(json.dumps(o, sort_keys=True, default=str).encode()).hexdigest()


# ---- the served edition: citable ids and the number check ----

def index(doc):
    """Every citable id of a served edition: id -> (kind, element, section id or None). The cover is section summary."""
    ids = {"summary": ("section", {k: v for k, v in doc["cover"].items() if k != "blocks"}, "summary")}
    for b in doc["cover"].get("blocks", []):
        ids[b["id"]] = ("block", b, "summary")
    if isinstance(doc["cover"].get("kpis"), dict) and doc["cover"]["kpis"].get("id"):
        ids[doc["cover"]["kpis"]["id"]] = ("block", doc["cover"]["kpis"], "summary")
    for s in doc["sections"] + doc.get("appendix", []):
        ids[s["id"]] = ("section", {k: v for k, v in s.items() if k != "blocks"}, s["id"])
        for b in s["blocks"]:
            ids[b["id"]] = ("block", b, s["id"])
    for kind, key in (("glossary", "glossary"), ("source", "sources"), ("fact", "facts")):
        for x in doc.get(key, []):
            ids[x["id"]] = (kind, x, None)
    return ids


def strings(o):
    """The reader-visible strings of an element (ids and codes left out)."""
    if isinstance(o, dict):
        for k, v in o.items():
            if k not in SKIP_KEYS:
                yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)
    elif isinstance(o, str):
        yield o


def plain(text):
    """Text without {fact:id} tokens and [src-id] references (they carry ids, not figures)."""
    return SRC_REF.sub(" ", TOKEN.sub(" ", text))


def blank(m):
    """A match as spaces of its length, so what stays keeps its place in the text."""
    return " " * len(m[0])


def unlisted(text):
    """`text` without the numbers of its ordered lists: runs of two or more lines from 1, each one more than the last. A lone
    "12. Revenue rose." at a line's start stays, as it can be the end of a sentence."""
    run = []
    for m in [*LIST_ITEM.finditer(text), None]:
        if m and int(m[1]) == len(run) + 1:
            run.append(m)
            continue
        for n in run if len(run) > 1 else ():
            text = text[:n.start()] + blank(n) + text[n.end():]
        run = [m] if m and m[1] == "1" else []
    return text


def norm(intpart, frac):
    """A figure's digits: no thousands commas, no leading zeros, no trailing zeros after the point."""
    i, f = intpart.replace(",", "").lstrip("0") or "0", (frac or "").lstrip(".").rstrip("0")
    return i + ("." + f if f else "")


def figure(m, exp=0):
    """A figure as printed: (digits, % or not, scale exponent). The scale word or context after the figure sets the
    exponent ("4.48 billion" -> ("4.48", False, 9), "4,475,446 (USD thousands)" -> ("4475446", False, 3)); without one
    it is `exp` (see `support`; 0 for an answer's figures)."""
    # 99: a spelling re.I folds to a scale but no scale word ("bıllıon"), so nothing supports it
    scale = SCALE_WORDS.get(m[4].casefold().strip("()").split()[-1].removesuffix("s"), 99) if m[4] else exp
    return norm(m[1], m[2]), bool(m[3]), scale


def heading(el):
    """A filing-table block's text before its first row (the adapter joins lead-in, row and footnote lines with
    newlines). Rows that are not found as lines leave nothing (fail closed); a table without rows is all lead-in."""
    rows = [" ".join(c.get("text", "") for c in r if c.get("text", "").strip())
            for r in el["filing_table"].get("rows", [])]
    first, lines = next((r for r in rows if r), None), (el.get("text") or "").split("\n")
    return "\n".join(lines if first is None else lines[:lines.index(first)] if first in lines else [])


def support(entry, facts):
    """(figures printed in the element's text, facts it shows) for one cited element. A block shows the facts its
    {fact:id} tokens and fact-id cells name; a fact shows itself. Each shown fact adds its printed form and, unless it is
    a ratio, its value; forms, locators and dates in the text (NOT_FIGURE) are no figures here either. Digits equal to the printed form or value of a linked fact (one it shows, or one quoted from this source)
    carry that fact's scale. Revenue "4,475,446" (USD thousands), whether in the fact or in src-18's quote "Revenue
    $ 4,475,446", gives ("4475446", False, 3), so a bare "$4,475,446" is not supported. In a source quote whose linked
    facts share one scale, every other comma-grouped, non-% amount takes it too (src-23's other years: "1,378,247" is
    USD thousands). In a filing-table block they take the scale its heading states ("(in thousands", in its text before
    the first row; not a stray "shares in millions" nor a footnote after the rows) and its linked facts have, when only
    one is found; with none or two, they support nothing (exponent None: never whole dollars).
    Other digits have none. A year in the text ("FY2025", "in 2025") supports no amount: `verify` reads bare years itself."""
    kind, el, _ = entry
    shown, text = ([el] if kind == "fact" else []), []
    # a fact's only figures are its printed form and value (below), a source's those of its quote, not of its locator
    for s in [] if kind == "fact" else [el.get("quote") or ""] if kind == "source" else strings(el):
        if s in facts:
            shown.append(facts[s])
            continue
        shown += [facts[t] for t in TOKEN.findall(s) if t in facts]
        text.append(plain(s))
    linked = shown + [f for f in facts.values() if f.get("source") == el.get("id")]
    at = {norm(m[1], m[2]): SCALE_EXP.get(f.get("scale"), 0)
          for f in linked for m in NUMBER.finditer(f"{f.get('shown') or ''} {f.get('value') or ''}")}
    scales = {SCALE_EXP.get(f.get("scale"), 0) for f in linked}
    if "filing_table" in el:
        scales |= {SCALE_WORDS[w.lower()] for w in STATED.findall(plain(heading(el)))}
        table = scales.pop() if len(scales) == 1 else None
    else:
        table = scales.pop() if kind == "source" and len(scales) == 1 else 0  # the scale of the table a quote comes from
    for f in shown:  # a ratio's stored value is no printed figure: 0.38 is shown as 38%
        text += [f.get("shown") or "", "" if f.get("unit") == "ratio" else f.get("value") or ""]
    return {figure(m, at.get(d, table if "," in m[1] and not m[3] else 0))
            for m in PRINTED.finditer(NOT_FIGURE.sub(blank, " ".join(text)))
            if (d := norm(m[1], m[2])) in at or not YEAR.fullmatch(m[0])}, shown


def magnitudes(f, pct):
    """A fact's value as an answer may state it: with %, only a ratio x 100 (0.31595 -> 31.595); otherwise in whole
    units only (value x 10^scale: 4475446 thousands -> 4,475,446,000), never the stored digits read at another scale."""
    try:
        v = abs(Decimal(f["value"]))
    except (decimal.InvalidOperation, KeyError, TypeError):
        return []
    if pct:
        return [v * 100] if f.get("unit") == "ratio" else []
    return [v.scaleb(SCALE_EXP.get(f.get("scale"), 0))]


def supported(m, figures, facts):
    """A figure is supported when (a) the cited text prints it the same way (digits, % or not, scale exponent; a shown
    fact's printed digits are at the fact's scale), or (b) it equals a shown fact's value in whole units, divided by its
    scale word (thousand, million, billion) and rounded (half up or half even) to the decimals the answer prints, and
    within 5% of it ("$1" for 0.63 rounds but is no statement of it); a % figure equals a ratio x 100 so rounded, with no 5% limit ("1%" for 1.37%) unless it rounds to 0. A cited amount whose scale is known (a figure tuple with an exponent) counts
    for (b) like a fact's value: src-23's 1,378,247 (USD thousands) supports "$1.38 billion". Revenue 4,475,446 USD
    thousands: "$4.48 billion", "4,475,446 thousand" and "4,475,446 (USD thousands)" verify; "$4,475,446", "$4.48
    million", "$4,475,446 billion", "$0 trillion" (any amount rounds to it) and "2025%" do not. Calculated facts
    (margins, growth, tax rate) have no printed form, so a stated "31.6%" verifies only by (b): op-margin 0.31595... x
    100 = 31.595... -> 31.6 (one decimal) or 32 (none)."""
    intpart, frac, pct, _ = m.groups()
    if (fig := figure(m))[2] and fig[0] == "0":
        return False
    if fig in figures:
        return True
    n, dp = Decimal(intpart.replace(",", "") + (frac or "")), len(frac or ".") - 1
    exp = fig[2]
    rate = "usd_per_share" if exp == -2 else "ratio" if exp < 0 else None  # cents read a per-share amount, bps and ‰ a ratio
    with decimal.localcontext(prec=80):
        whole = [v for f in facts if (f.get("unit") == rate if rate else pct or f.get("unit") != "ratio")
                 for v in magnitudes(f, pct)]
        whole += [] if pct or exp < 0 else [Decimal(d).scaleb(e) for d, p, e in figures if e and e > 0 and not p]
        try:
            for v in whole:
                x = v if pct else v.scaleb(-exp)
                if (pct and n or abs(x - n) <= abs(x) * ROUNDING) and any(x.quantize(Decimal(1).scaleb(-dp), rounding=r) == n
                                                                          for r in (ROUND_HALF_UP, ROUND_HALF_EVEN)):
                    return True
        except decimal.InvalidOperation:  # more digits than the context holds: no figure of a report
            return False
    return False


def verify(answer, cited, ids):
    """Code check of a model answer against the served edition. Returns (problems, numbers, known cited ids). Every cited
    id must exist, a {fact:id} token must name a fact and a [src-id] reference a source; every figure written in digits
    must be supported by a cited element (see `supported`), apart from the day of a date, lengths of time and locators (NOT_FIGURE)
    and a bare year the report prints (YEAR);
    an amount written in words is never verified; an answer citing nothing is not verified. A figure in another currency is never
    supported, and shares or dollars beside a figure read only against a fact of that unit: a fact cited, the facts a source is quoted for, and in any other element the figures of its facts. It checks figures, not meaning: "grew" or
    "fell", signs, comparisons and which line or year a figure is said to belong to are not checked. An unmatched figure carries `span`, its place in `answer` in code points, so the page can mark that one."""
    facts = {k: e[1] for k, e in ids.items() if e[0] == "fact"}
    cited = list(dict.fromkeys([*cited, *TOKEN.findall(answer), *SRC_REF.findall(answer)]))
    problems = [f"unknown id {c!r}" for c in cited if c not in ids]
    problems += [f"{{fact:{t}}} names a {ids[t][0]}, not a fact" for t in TOKEN.findall(answer)
                 if t in ids and ids[t][0] != "fact"]
    problems += [f"[{t}] names a {ids[t][0]}, not a source" for t in SRC_REF.findall(answer)
                 if t in ids and ids[t][0] != "source"]
    known = [c for c in cited if c in ids]
    if not known:
        problems.append("the answer cites nothing in the report")
    sup = {c: support(ids[c], facts) for c in known}
    prose = SRC_REF.sub(blank, TOKEN.sub(blank, answer))
    problems += [f"a scale or a $ beside a fact token: {m[0]!r}" for m in TOKEN_SCALED.finditer(EMPHASIS.sub(blank, answer))]
    numbers, text = [], unlisted(NOT_FIGURE.sub(blank, EMPHASIS.sub(blank, prose)))
    years = {y for e in ids.values() for t in strings(e[1]) for y in YEAR.findall(t)}

    def reads(c, m):
        figs, fs = sup[c]
        dollars, shares = MONEY_BEFORE.search(text, 0, m.start()) or DOLLARS_BESIDE.search(m[0]), SHARES_AFTER.match(text, m.end())
        if dollars and shares or figure(m)[2] == -2 and (dollars or SCALE_AFTER.match(text, m.end())):
            return False  # two units at once: "$23.9억 주", "$63 cents", "63 cents billion"
        unit = "shares" if shares else "dollars" if dollars or DOLLARS_BESIDE.match(text, m.end()) else None
        if unit:
            kin = fs + [f for f in facts.values() if f.get("source") == c]
            other = [f for f in kin if f.get("unit") not in UNITS[unit]]
            if ids[c][0] in ("fact", "source") and kin and kin == other:
                return False
            fs = [f for f in fs if f.get("unit") in UNITS[unit]]
            figs = figs.difference(*(support(("fact", f, None), facts)[0] for f in other))
        return supported(m, figs, fs)

    for m in NUMBER.finditer(text):
        abroad = ABROAD_BEFORE.search(text, 0, m.start()) or ABROAD_AFTER.match(text, m.end())
        by = None if abroad else next((c for c in sup if reads(c, m)), None)
        if by:
            numbers.append({"text": m[0].strip(), "supported_by": by})
        elif not (m[0] in years and (DATE_BEFORE.search(text, 0, m.start()) or not (
                MONEY_BEFORE.search(text, 0, m.start()) or UNIT_AFTER.match(text, m.end())))):
            numbers.append({"text": m[0].strip(), "supported_by": None, "span": list(m.span())})
            problems.append(f"the figure {m[0].strip()!r} is not in any cited element")
    for m in SPELLED.finditer(text):
        numbers.append({"text": m[0], "supported_by": None, "span": list(m.span())})
        problems.append(f"the amount {m[0]!r} is written in words; only figures in digits can be checked")
    return problems, numbers, known


def reading(f):
    """A fact's value in whole units, for the prompt only (never the served or stored edition), in the form the number
    check accepts by rule (b): an amount to 3 significant figures (half even) with the word its size picks, a ratio as
    a percent with one decimal. Revenue 4475446 USD thousands -> "4,475,446 (USD thousands) = $4.48 billion"; ratio
    0.3159495 -> "0.3159495 (ratio) = 31.6%". None for other units."""
    try:
        v = Decimal(f["value"])
    except (decimal.InvalidOperation, KeyError, TypeError):
        return None
    if f.get("unit") == "ratio":
        return f"{f['value']} (ratio) = {(v * 100).quantize(Decimal('0.1'), ROUND_HALF_EVEN)}%"
    if f.get("unit") not in READ_UNITS:
        return None
    u = v.scaleb(SCALE_EXP.get(f.get("scale"), 0))
    exp, word = next(((e, " " + w) for e, w in READ_WORDS if abs(u) >= Decimal(10) ** e), (0, ""))
    x = abs(u).scaleb(-exp)
    x = x.quantize(Decimal(1).scaleb(min(x.adjusted() - 2, 0)), ROUND_HALF_EVEN)
    amount = ("-" if u < 0 else "") + ("" if f["unit"] == "shares" else "$") + f"{x:,f}{word}" + {
        "shares": " shares", "usd_per_share": " per share"}.get(f["unit"], "")
    scale = "" if f.get("scale", "units") == "units" else " " + f["scale"]
    return f"{f.get('shown') or f['value']} ({READ_UNITS[f['unit']]}{scale}) = {amount}"


def decided_notice(n, ui_actions):
    """What a decisions request did when no answer followed; saved items only when an approved write was stored."""
    did = "Your decision was applied" if n == 1 else "Your decisions were applied"
    saved = any(a.get("type") == "overlay_added" for a in ui_actions)
    return did + (" and what you approved is saved" if saved else "") + ", but no answer followed."


def cant_text(doc):
    f = doc["filing"]
    return (f"This report, built from the {f.get('form')} for fiscal {f.get('fiscal_year')}, doesn't cover that. Athena "
            "answers only from the report, and it won't guess prices or forecasts or give investment advice.")


# ---- HTTP API ----

INTENTS = {  # quick actions: a fixed task line, after the element the reader points at (anchor_id), before their words
    "explain_figure": "Explain this figure in plain words: what it measures, for which period, and how the report "
                      "states it.",
    "compare_periods": "Compare this figure with the other periods the report shows, and the change between them.",
    "define_term": "Define this term in plain words, as the report uses it.",
}


class AskIn(BaseModel):
    question: Annotated[str, Field(max_length=4000)] = ""  # may be empty when an intent is sent
    thread_id: Annotated[int, Field(ge=1, le=2**63 - 1)] | None = None
    intent: Annotated[str | None, Field(max_length=40, description="a quick action: explain_figure, compare_periods "
                                        "or define_term (anything else is 400)")] = None
    anchor_id: Annotated[str | None, Field(max_length=128, description="an id of the served edition the reader points "
                                           "at; its element is set ahead of the question (unknown is 400)")] = None


class DecisionIn(BaseModel):
    id: Annotated[str, Field(min_length=1, max_length=128)]
    type: Literal["approve", "edit", "reject"]
    args: dict[str, Any] | None = None  # edit: the reader's replacement arguments
    message: Annotated[str, Field(max_length=500)] | None = None  # reject: the reader's reason, shown to the model


class DecisionsIn(BaseModel):
    decisions: Annotated[list[DecisionIn], Field(min_length=1, max_length=10)]


class AskOut(BaseModel):
    state: Literal["answered", "needs_approval", "unverified", "disabled", "refused"]
    thread_id: int
    answer: str | None = None  # may hold {fact:id} tokens and [src-id] references, as the report text does
    citations: list[dict[str, Any]] = []  # [{id, kind, section_id}], ids that exist in the served edition
    numbers: list[dict[str, Any]] = []  # [{text, supported_by, span?}]: every figure in the answer and the cited id behind it
    problems: list[str] = []  # why an answer is unverified
    ui_actions: list[dict[str, Any]] = []
    pending_actions: list[dict[str, Any]] = []  # [{id, tool, args, problems}]: writes waiting for the reader
    code: str | None = None  # refused or disabled: why
    notice: str | None = None


def add_routes(app: FastAPI, db, db_path, served, cfg, jobs_cfg):
    """POST /api/editions/{id}/ask and POST /api/editions/{id}/ask/{thread_id}/decisions. `served(conn, id)` returns
    the client document or raises 404; `cfg` comes from load_config (None: keyless)."""
    if cfg:
        from . import ask_agent
        init_ledger(cfg["agent_db"])
    busy, busy_lock = set(), threading.Lock()

    def thread(conn, edition_id, reader, thread_id):
        th = store.get_overlay(conn, edition_id, reader, thread_id)
        if not th or th["kind"] != "thread" or th["body"].get("mode") != "ask":
            raise HTTPException(404, "thread not found")
        return th

    def append(conn, edition_id, reader, th, *msgs):
        th["body"]["messages"] = th["body"].get("messages", []) + [{**m, "created_at": store.now()} for m in msgs]
        store.update_overlay(conn, edition_id, reader, th["id"], body=th["body"])

    @contextlib.contextmanager
    def one_turn(key):
        with busy_lock:
            if key in busy:
                raise Refusal(409, "busy", "this thread is answering already")
            busy.add(key)
        try:
            yield
        finally:
            with busy_lock:
                busy.discard(key)

    def anchor_of(i, ids):  # a thread started from an element keeps it as its anchor
        if not i:
            return {}
        kind, _, section_id = ids[i]
        key = {"block": "block_id", "fact": "fact"}.get(kind, "id")  # the Desk's memo anchor keys where they apply
        return {"revision_id": "rev-1", "section_id": section_id, key: i}

    def turn_text(q, ids):
        """The new human turn: the element the reader points at, the quick action, then the reader's words. The stable
        prefix (instructions, edition, conversation) is unchanged ahead of it."""
        parts = []
        if q.anchor_id:
            kind, el, section_id = ids[q.anchor_id]
            parts.append(f"[The reader points at {kind} {q.anchor_id}" + (f" in chapter {section_id}" if section_id else "")
                         + ": " + json.dumps(el, ensure_ascii=False, sort_keys=True) + "]")
        if q.intent:
            parts.append(f"[Quick action {q.intent}] {INTENTS[q.intent]}")
        if q.question.strip():
            parts.append(q.question)
        return "\n".join(parts)

    def finish(conn, edition_id, reader, th, out):
        append(conn, edition_id, reader, th, {"role": "assistant", "mode": "ask", **out})
        if cfg and out["state"] != "needs_approval":
            record(cfg["agent_db"], "ask_answers", {"thread_id": th["id"], "edition_id": edition_id,
                   "reader_sha256": store.sha256(reader.encode()), "state": out["state"],
                   "reason": out.get("code") or "; ".join(out.get("problems", [])) or None})
        return {"thread_id": th["id"], **out}

    @app.post("/api/editions/{edition_id}/ask", response_model=AskOut, response_model_exclude_none=True)
    def ask(request: Request, edition_id: Id, q: AskIn):
        reader = request.state.reader
        with contextlib.closing(db()) as conn:
            doc = served(conn, edition_id)
            ids = index(doc)
            if q.intent is not None and q.intent not in INTENTS:
                raise HTTPException(400, f"unknown intent; known: {', '.join(INTENTS)}")
            if q.anchor_id is not None and q.anchor_id not in ids:
                raise HTTPException(400, "anchor_id is not an id of this edition")
            if not (q.question.strip() or q.intent):
                raise HTTPException(400, "send a question or an intent")
            if q.thread_id is None:
                from .server import MAX_OVERLAYS_PER_READER  # late: server imports this module
                if store.count_overlays(conn, reader) >= MAX_OVERLAYS_PER_READER:
                    raise HTTPException(429, f"a reader keeps at most {MAX_OVERLAYS_PER_READER} memos and threads")
                anchor = anchor_of(q.anchor_id, ids)
                store.ensure_user(conn, reader)
                th = store.add_overlay(conn, edition_id, reader, "thread", anchor,
                                       {"mode": "ask", "status": "open", "messages": []})
            else:
                th = thread(conn, edition_id, reader, q.thread_id)
            turn = live(reader, edition_id, th, doc, ids) if cfg else contextlib.nullcontext()
            try:
                with one_turn(th["id"]), turn as agent:
                    if agent and agent.pending():
                        raise Refusal(409, "pending_actions", "decide the pending actions of this thread first")
                    append(conn, edition_id, reader, th, {"role": "user", "mode": "ask", "text": q.question, **{
                        k: v for k, v in (("intent", q.intent), ("anchor_id", q.anchor_id)) if v}})
                    if ADVICE_Q.search(q.question):
                        return finish(conn, edition_id, reader, th, {"state": "refused", "code": "outside_filings",
                                                                      "answer": cant_text(doc)})
                    if not agent:
                        return finish(conn, edition_id, reader, th, {"state": "disabled", "code": "live_answers_off",
                                                                      "notice": OFF_NOTICE})
                    return finish(conn, edition_id, reader, th, agent.ask(turn_text(q, ids)))
            except Refusal as e:  # a failure after the thread exists names it: a new thread is not lost
                e.extra.setdefault("thread_id", th["id"])
                raise
            except Exception as e:  # anything else is mapped too: no raw exception leaves the route
                raise failed(e, th) from None

    @app.post("/api/editions/{edition_id}/ask/{thread_id}/decisions", response_model=AskOut,
              response_model_exclude_none=True)
    def decide(request: Request, edition_id: Id, thread_id: Id, d: DecisionsIn):
        reader = request.state.reader
        with contextlib.closing(db()) as conn:
            doc = served(conn, edition_id)
            th = thread(conn, edition_id, reader, thread_id)
            if not cfg:
                return finish(conn, edition_id, reader, th, {"state": "disabled", "code": "live_answers_off",
                                                              "notice": OFF_NOTICE})
            try:
                with one_turn(th["id"]), live(reader, edition_id, th, doc, index(doc)) as agent:
                    decided = {"role": "user", "mode": "decisions",
                               "decisions": [x.model_dump(exclude_none=True) for x in d.decisions]}
                    try:
                        out = agent.decide(d.decisions)
                    except Refusal as e:  # after the decisions ran (ui_actions set): keep them and what they stored
                        if "ui_actions" not in e.extra:
                            raise
                        e.extra |= {"thread_id": th["id"],
                                    "notice": decided_notice(len(d.decisions), e.extra["ui_actions"])}
                        append(conn, edition_id, reader, th, decided, {
                            "role": "assistant", "mode": "ask", "code": e.code, "notice": e.extra["notice"],
                            "ui_actions": e.extra["ui_actions"]})
                        raise
                    append(conn, edition_id, reader, th, decided)
                    return finish(conn, edition_id, reader, th, out)
            except Refusal:
                raise
            except Exception as e:  # anything else is mapped too: no raw exception leaves the route
                raise failed(e, th) from None

    def failed(e, th):
        LOG.error("ask request failed: %s", type(e).__name__)  # the type only: a message may echo a key
        return Refusal(*ASK_FAILED, thread_id=th["id"])

    @contextlib.contextmanager
    def live(reader, edition_id, th, doc, ids):
        check_route(cfg["model"])  # the route check runs before any model client exists
        with ask_agent.checkpointer(cfg["agent_db"]) as saver:  # one checkpoint connection per request
            yield ask_agent.Turn(cfg, saver, cfg.get("chat_model", chat_model)(cfg), db_path=db_path, reader=reader,
                                 edition_id=edition_id, thread_id=th["id"], doc=doc, ids=ids,
                                 catalog=jobs_cfg and jobs_cfg["catalog"])
