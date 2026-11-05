"""{quote:src-id} tokens: the served edition sets the source's own quote in the text (adapter.quotes), so the Desk,
Ask's prompt and the number check all read the same words. The stored document keeps its tokens (same doc_sha256)."""
import copy

import pytest
from fastapi.testclient import TestClient

from athena_app import store
from athena_app.adapter import AdapterError, adapt_v2_to_v3, canonical, client_view, quotes
from athena_app.server import create_app
from conftest import META, UI


def test_served_r14_has_no_quote_tokens(db_path, seeded):
    c = TestClient(create_app(db_path, UI), base_url="http://127.0.0.1")
    doc = c.get(f"/api/reports/{seeded}").json()["document"]
    assert "{quote:" not in canonical(doc).decode() and "{quote:" not in c.get(f"/reports/{seeded}").text
    blocks = {b["id"]: b.get("text") for s in doc["sections"] for b in s["blocks"]}
    assert ("The filing states “Our top three customers together accounted for 16% and 17% of our revenue for the "
            "years ended December 31, 2025 and 2024, respectively.” [src-12].") in blocks["risks-concentration"]
    assert "“Finance leases are not material.”" in blocks["invest-leases"]
    conn = store.connect(db_path)
    stored = store.get_document(conn, store.get_edition(conn, seeded)["doc_sha256"])
    conn.close()
    assert canonical(stored).decode().count("{quote:") == 2  # ingest-time bytes are unchanged; only serving sets them


def test_unknown_quote_source_fails_loudly(v2, v3, chapters):
    bad = copy.deepcopy(v3)
    bad["sections"][0]["blocks"][0]["text"] += " {quote:src-999}"
    with pytest.raises(AdapterError, match="src-999"):
        client_view(bad)
    doc = copy.deepcopy(v2)
    doc["sections"][1]["blocks"][0]["text"] += " {quote:src-999}"
    with pytest.raises(AdapterError, match="src-999"):  # and an ingest refuses it before any edition exists
        adapt_v2_to_v3(doc, {**META, "chapters": chapters})


def test_quote_tokens_never_pass_silently():
    """A quote holding a token or markup, and an empty or unterminated token, raise."""
    src = {"src-1": {"quote": "plain  words"}, "src-2": {"quote": "has {fact:x}"}, "src-3": {"quote": "see [src-1]"},
           "src-4": {"quote": "**bold**"}}
    assert quotes("A {quote:src-1} B", src) == "A “plain words” B"
    for bad in ("{quote:src-2}", "{quote:src-3}", "{quote:src-4}", "{quote:}", "x {quote:src-1"):
        with pytest.raises(AdapterError):
            quotes(bad, src)
