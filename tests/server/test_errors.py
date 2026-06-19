#!/usr/bin/env python3
"""Test matrix for the server error catalog: every failure comes
back as {ok:false, error:{code, message}} with a structured code (the code is the contract).
Gateway-domain errors (Gateway:*) carry a "did you mean" hint; runtime failures surface the
located Viper diagnostic with its Component:Domain:Code lifted onto the wire.
"""
import sys
import uuid
import dsviper
from app import Gateway

from graph_fixture import GRAPH_DSM, build
VIS = "Graph::Vertex.visualAttributes"

PASS, FAIL = [], []
def test(name, fn):
    try:
        fn(); PASS.append(name); print(f"  ✓ {name}")
    except Exception as e:
        FAIL.append(name); print(f"  ✗ {name}\n        {type(e).__name__}: {e}")
def eq(a, b): assert a == b, f"{a!r} != {b!r}"

def load():
    b = dsviper.DSMBuilder(); b.append("g", open(GRAPH_DSM).read())
    _, _, dc = b.parse()
    db = dsviper.CommitDatabase.create_in_memory(); db.extend_definitions(dc)
    return db

gw = Gateway(load())
def ex(c): return gw.execute(c)
K = str(uuid.uuid4())
# seed one vertex so reads resolve
ex({"op": "commit", "base": "head", "label": "seed", "mutations": [
    {"set": {"attachment": VIS, "key": {"instance": K},
             "value": {"value": 1, "color": {"red": 0.0, "green": 0.0, "blue": 0.0}}}}]})

print(f"dsviper {dsviper.version()} | server error catalog\n")

def t_unknown_op():
    r = ex({"op": "frobnicate"})
    assert not r["ok"]; eq(r["error"]["code"], "Gateway:Op:Unknown")
test("unknown op -> Gateway:Op:Unknown", t_unknown_op)

def t_unknown_attachment():
    r = ex({"op": "keys", "view": "head", "attachment": "Graph::Vertex.visualAttribute"})   # typo: missing 's'
    assert not r["ok"]; eq(r["error"]["code"], "Gateway:Attachment:Unknown")
    assert "Did you mean" in r["error"]["message"] and VIS in r["error"]["message"], r["error"]["message"]
test("unknown attachment -> Gateway:Attachment:Unknown + did-you-mean", t_unknown_attachment)

def t_unknown_verb():
    r = ex({"op": "commit", "base": "head", "mutations": [{"frobnicate": {"attachment": VIS, "key": {"instance": K}}}]})
    assert not r["ok"]; eq(r["error"]["code"], "Gateway:Verb:Unknown")
test("unknown verb -> Gateway:Verb:Unknown", t_unknown_verb)

def t_bad_commit_id():
    r = ex({"op": "get", "view": "zzzz", "attachment": VIS, "key": {"instance": K}})
    assert not r["ok"]
    assert r["error"]["code"].startswith("Viper.CommitId"), r["error"]            # runtime located diagnostic
test("bad commit id -> Viper.CommitId:* lifted onto the wire", t_bad_commit_id)

def t_type_mismatch():
    r = ex({"op": "commit", "base": "head", "mutations": [
        {"set": {"attachment": VIS, "key": {"instance": K}, "value": {"value": "not-an-int"}}}]})
    assert not r["ok"] and isinstance(r["error"]["code"], str) and r["error"]["code"], r
test("type mismatch on commit -> structured error", t_type_mismatch)

def t_success_still_ok():
    r = ex({"op": "get", "view": "head", "attachment": VIS, "key": {"instance": K}})
    assert r["ok"] and r["value"]["value"] == 1
test("a valid call still succeeds", t_success_still_ok)

print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
