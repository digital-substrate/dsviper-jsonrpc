#!/usr/bin/env python3
"""Test matrix for the server DAG surface: navigation reads,
the DAG write ops, schema, and -- the heart of it -- the divergence flow: two commits on
one base produce multiple heads, reconciled explicitly via mergeCommit / reduceHeads.
The server never reconciles on its own; it exposes the primitives and signals divergence.
"""
import sys
import uuid
import dsviper
from app import Gateway

from graph_fixture import GRAPH_DSM, build

DESC = "Graph::Graph.description"

PASS, FAIL = [], []


def test(name, fn):
    try:
        fn();
        PASS.append(name);
        print(f"  ✓ {name}")
    except Exception as e:
        FAIL.append(name);
        print(f"  ✗ {name}\n        {type(e).__name__}: {e}")


def eq(a, b): assert a == b, f"{a!r} != {b!r}"


def load():
    b = dsviper.DSMBuilder();
    b.append("g", open(GRAPH_DSM).read())
    _, _, dc = b.parse()
    db = dsviper.CommitDatabase.create_in_memory();
    db.extend_definitions(dc)
    return db


def commit_desc(gw, base, name, instance):
    return gw.execute({"op": "commit", "base": base, "label": name, "mutations": [
        {"set": {"attachment": DESC, "key": {"instance": instance},
                 "value": {"name": name, "author": "", "createDate": ""}}}]})


gw = Gateway(load())


def ex(c): return gw.execute(c)


GK = str(uuid.uuid4())

print(f"dsviper {dsviper.version()} | server DAG matrix\n")
print("=== build a DAG with a divergence ===")
c0 = commit_desc(gw, "head", "base", GK)["commitId"]
cA = commit_desc(gw, c0, "A", GK)["commitId"]
rB = commit_desc(gw, c0, "B", GK)  # second child of c0 -> divergence
cB = rB["commitId"]


def t_divergence():
    assert "heads" in rB, rB  # op_commit signals divergence
    eq(len(ex({"op": "heads"})["heads"]), 2)


test("two commits on one base -> heads signalled", t_divergence)


def t_children():
    eq(set(ex({"op": "children", "commitId": c0})["commitIds"]), {cA, cB})


test("children(base) = {A, B}", t_children)


def t_header():
    h = ex({"op": "commitHeader", "commitId": cA})["header"]
    eq(h["label"], "A");
    eq(h["parent"], c0);
    eq(h["target"], None)
    assert isinstance(h["timestamp"], float)


test("commitHeader (label/parent; target=None for a non-merge)", t_header)


def t_ancestor():
    assert ex({"op": "isAncestor", "commitId": c0, "descendant": cA})["isAncestor"]
    assert not ex({"op": "isAncestor", "commitId": cA, "descendant": cB})["isAncestor"]


test("isAncestor", t_ancestor)


def t_mergeable():
    assert ex({"op": "isMergeable", "parent": cA, "merged": cB})["isMergeable"]


test("isMergeable(A, B)", t_mergeable)

print("\n=== reconcile, explicitly ===")


def t_merge():
    r = ex({"op": "mergeCommit", "label": "merge B", "parent": cA, "merged": cB})
    assert r["ok"] and r["commitId"], r
    h = ex({"op": "commitHeader", "commitId": r["commitId"]})["header"]
    eq(h["target"], cB)  # the merge header carries the merged side
    eq(len(ex({"op": "heads"})["heads"]), 1)


test("mergeCommit collapses to one head, target = B", t_merge)


def t_disable_enable():
    head = ex({"op": "heads"})["heads"][0]
    rd = ex({"op": "disableCommit", "label": "drop A", "parent": head, "disabled": cA})
    assert rd["ok"] and rd["commitId"], rd
    re = ex({"op": "enableCommit", "label": "restore A", "parent": rd["commitId"], "enabled": cA})
    assert re["ok"] and re["commitId"], re


test("disableCommit / enableCommit (undo idiom)", t_disable_enable)


def t_reduce_single():
    r = ex({"op": "reduceHeads"})
    assert r["ok"]  # commitId may be null when already a single head


test("reduceHeads on a single head -> ok", t_reduce_single)

print("\n=== reduceHeads converges a fresh divergence ===")


def t_reduce_diverge():
    gw2 = Gateway(load());
    k = str(uuid.uuid4())
    z = commit_desc(gw2, "head", "z", k)["commitId"]
    commit_desc(gw2, z, "x", k);
    commit_desc(gw2, z, "y", k)  # two children -> divergence
    eq(len(gw2.execute({"op": "heads"})["heads"]), 2)
    r = gw2.execute({"op": "reduceHeads"})
    assert r["ok"] and r["commitId"], r
    eq(len(gw2.execute({"op": "heads"})["heads"]), 1)


test("reduceHeads converges two heads into one", t_reduce_diverge)

print("\n=== schema + first/last ===")


def t_schema_dsm():
    r = ex({"op": "schema", "form": "dsm"})
    assert r["ok"] and "namespace Graph" in r["dsm"], r


test("schema form=dsm", t_schema_dsm)


def t_schema_json():
    r = ex({"op": "schema", "form": "json"})
    assert r["ok"] and isinstance(r["json"], (dict, list)), type(r.get("json"))


test("schema form=json", t_schema_json)


def t_first_last():
    assert ex({"op": "firstCommitId"})["commitId"] and ex({"op": "lastCommitId"})["commitId"]


test("first / lastCommitId", t_first_last)

print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
