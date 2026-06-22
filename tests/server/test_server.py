#!/usr/bin/env python3
"""Test matrix for the server core: the wire ops driven through
Gateway.execute() in-process. Exercises the read core, the eleven-verb commit envelope, and
-- the point of this step -- the embedded-key UN-PROJECTION (runtime [hex,hex] -> human
{instance, concept}) on row keys, key lists, and embedded key fields inside documents.

Graph model in-memory (writable, full verb matrix) + a built Graph fixture (read-only).
"""
import os
import sys
import tempfile
import dsviper
from app import Gateway

from graph_fixture import GRAPH_DSM, build

A_GRAPH = build(os.path.join(tempfile.mkdtemp(), "a.graph"))

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


# ---------------------------------------------------------------- in-memory Graph server
def load():
    b = dsviper.DSMBuilder();
    b.append("g", open(GRAPH_DSM).read())
    _, _, dc = b.parse()
    db = dsviper.CommitDatabase.create_in_memory();
    db.extend_definitions(dc)
    return db


gw = Gateway(load())


def ex(cmd): return gw.execute(cmd)


VIS = "Graph::Vertex.visualAttributes"
TOPO = "Graph::Graph.topology"
import uuid

VKS = [str(uuid.uuid4()) for _ in range(3)]
GK = str(uuid.uuid4())

print(f"dsviper {dsviper.version()} | server core matrix\n")
print("=== write: the eleven-verb envelope (base-pinned) ===")


def t_commit_set():
    muts = [{"set": {"attachment": VIS, "key": {"instance": u},
                     "value": {"value": i + 1, "color": {"red": 0.1 * (i + 1), "green": 0.0, "blue": 0.0}}}}
            for i, u in enumerate(VKS)]
    r = ex({"op": "commit", "base": "head", "label": "seed vertices", "mutations": muts})
    assert r["ok"] and r["commitId"], r


test("commit set ×3 (first commit on empty db)", t_commit_set)


def t_commit_update():
    r = ex({"op": "commit", "base": "head", "label": "bump", "mutations": [
        {"update": {"attachment": VIS, "key": {"instance": VKS[0]}, "path": "value", "value": 99}}]})
    assert r["ok"], r
    g = ex({"op": "get", "view": "head", "attachment": VIS, "key": {"instance": VKS[0]}})
    eq(g["value"]["value"], 99)


test("commit update + get round-trip", t_commit_update)


def t_commit_topology_keys():
    # GraphTopology.vertexKeys = set<key<Vertex>>; pass keys as {instance} wire form via union_in_set
    ex({"op": "commit", "base": "head", "label": "topo", "mutations": [
        {"set": {"attachment": TOPO, "key": {"instance": GK}, "value": {"vertexKeys": [], "edgeKeys": []}}}]})
    # mint key<Vertex> values: a Vertex key is built from the Vertex attachment keyType
    vis_att = gw._att(VIS)
    vkeys = [vis_att.create_key(dsviper.ValueUUId(u)) for u in VKS]
    base = gw.db.last_commit_id()
    mss = dsviper.CommitMutableState(dsviper.CommitStateBuilder.state(gw.db, base))
    mss.attachment_mutating().union_in_set(gw._att(TOPO), gw._att(TOPO).create_key(dsviper.ValueUUId(GK)),
                                           dsviper.Path().field("vertexKeys").const(), vkeys)
    gw.db.commit_mutations("link", mss)
    assert True


test("seed topology with vertex keys", t_commit_topology_keys)

print("\n=== read: un-projection — keys are HUMAN {instance, concept} ===")


def t_keys_human():
    r = ex({"op": "keys", "view": "head", "attachment": VIS})
    assert r["ok"] and len(r["keys"]) == 3, r
    for k in r["keys"]:
        eq(set(k), {"instance", "concept"})
        eq(k["concept"], "Graph::Vertex")


test("keys() -> {instance, concept:'Graph::Vertex'}", t_keys_human)


def t_get_value():
    r = ex({"op": "get", "view": "head", "attachment": VIS, "key": {"instance": VKS[1]}})
    eq(r["value"]["value"], 2)


test("get returns the document", t_get_value)


def t_has():
    r = ex({"op": "has", "view": "head", "attachment": VIS, "key": {"instance": VKS[0]}})
    assert r["has"]


test("has -> true", t_has)


def t_query_where():
    r = ex({"op": "query", "view": "head", "attachment": VIS,
            "where": {"op": "gte", "path": "value", "value": 2}})
    vals = sorted(row["document"]["value"] for row in r["rows"])
    eq(vals, [2, 3, 99])
    for row in r["rows"]:  # row key is un-projected too
        eq(row["key"]["concept"], "Graph::Vertex")


test("query where + human row keys", t_query_where)


def t_query_embedded_keys_unprojected():
    # topology.vertexKeys are key<Vertex> -> must render as {instance, concept}, NOT [hex,hex]
    r = ex({"op": "query", "view": "head", "attachment": TOPO})
    vks = r["rows"][0]["document"]["vertexKeys"]
    assert len(vks) == 3, vks
    for vk in vks:
        eq(set(vk), {"instance", "concept"})
        eq(vk["concept"], "Graph::Vertex")
    instances = {vk["instance"] for vk in vks}
    eq(instances, set(VKS))


test("query: EMBEDDED key<Vertex> fields un-projected", t_query_embedded_keys_unprojected)


def t_query_expand():
    r = ex({"op": "query", "view": "head", "attachment": TOPO,
            "expand": {"vertexKeys": VIS}})
    exp = r["rows"][0]["document"]["vertexKeys"]
    assert len(exp) == 3 and all("value" in d for d in exp), exp


test("query: expand vertexKeys -> visual docs", t_query_expand)


def t_diffkeys():
    cids = ex({"op": "commitIds"})["commitIds"]
    r = ex({"op": "diffKeys", "from": cids[0], "to": cids[-1], "attachment": VIS})
    assert r["ok"] and "added" in r and isinstance(r["added"], list)
    for bucket in ("added", "removed", "different", "same"):
        for k in r[bucket]:
            eq(set(k) <= {"instance", "concept"}, True)


test("diffKeys -> human key buckets", t_diffkeys)

print("\n=== DAG navigation ===")


def t_dag():
    assert len(ex({"op": "heads"})["heads"]) >= 1
    assert len(ex({"op": "commitIds"})["commitIds"]) > 0
    h = ex({"op": "heads"})["heads"][0]
    assert ex({"op": "commitExists", "commitId": h})["exists"]


test("heads / commitIds / commitExists", t_dag)


def t_unknown_op():
    r = ex({"op": "frobnicate"})
    assert not r["ok"] and r["error"]["code"] == "Gateway:Op:Unknown"


test("unknown op -> Gateway:Op:Unknown", t_unknown_op)

print("\n=== real database — a built fixture ===")


def t_agraph():
    rdb = dsviper.CommitDatabase.open(A_GRAPH, readonly=True)
    rgw = Gateway(rdb)
    keys = rgw.execute({"op": "keys", "view": "head", "attachment": "Graph::Vertex.visualAttributes"})
    eq(len(keys["keys"]), 5)
    eq(keys["keys"][0]["concept"], "Graph::Vertex")
    topo = rgw.execute({"op": "query", "view": "head", "attachment": "Graph::Graph.topology"})
    vks = topo["rows"][0]["document"]["vertexKeys"]
    eq(len(vks), 5)
    eq(vks[0]["concept"], "Graph::Vertex")


test("fixture: keys + embedded-key un-projection", t_agraph)

print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
