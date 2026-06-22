#!/usr/bin/env python3
"""Test matrix for the query language:

  A. the SERVER compiler (query.py): tagged tree -> py-linq chain, on the Graph
     model in-memory (deterministic) + a built Graph fixture;
  B. the LAZINESS claims (source.rows + the compiler's key-pushdown partition),
     observable only through a fake AttachmentGetting with a get() call counter.

The client Mongo dialect is exercised by the JavaScript suite (the shipped dialect is
client/mongo.mjs); here every query uses the tagged wire form directly.
In-memory, independent try/except per case so one run shows the full matrix.
"""
import os
import sys
import tempfile
import dsviper
import query
from source import rows
from py_linq import Enumerable

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


# ---------------------------------------------------------------- in-memory Graph fixture
def load():
    b = dsviper.DSMBuilder()
    b.append("Graph.dsm", open(GRAPH_DSM).read())
    _, _, defs_const = b.parse()
    db = dsviper.CommitDatabase.create_in_memory()
    db.extend_definitions(defs_const)
    return db


db = load()
insp = dsviper.DefinitionsInspector(db.definitions())
VIS = insp.check_attachment("Graph::Vertex.visualAttributes")
V2D = insp.check_attachment("Graph::Vertex.render2DAttributes")
TOPO = insp.check_attachment("Graph::Graph.topology")

VALUES = [1, 2, 2, 3, 5]
XS = [10.0, 20.0, 30.0, 40.0, 50.0]
VKS = [dsviper.ValueUUId.create() for _ in VALUES]
GK = dsviper.ValueUUId.create()


def _seed():
    ms = dsviper.CommitMutableState(dsviper.CommitStateBuilder.initial_state(db))
    am = ms.attachment_mutating()
    for u, v, x in zip(VKS, VALUES, XS):
        am.set(VIS, VIS.create_key(u),
               {"value": v, "color": {"red": v / 10.0, "green": 0.0, "blue": 0.0}})
        am.set(V2D, V2D.create_key(u), {"position": {"x": x, "y": 0.0}})
    am.set(TOPO, TOPO.create_key(GK),
           {"vertexKeys": [VIS.create_key(u) for u in VKS], "edgeKeys": []})
    return db.commit_mutations("seed", ms)


CID = _seed()
CS = dsviper.CommitStateBuilder.state(db, CID)


def run(q):
    q.setdefault("op", "query")
    return query.run_query(CS, insp, q)


def vals(rows_):
    return sorted(r["document"]["value"] for r in rows_)


def VIS_ID(): return "Graph::Vertex.visualAttributes"


def V2D_ID(): return "Graph::Vertex.render2DAttributes"


def _eq(a, b): assert a == b, f"{a} != {b}"


print(f"dsviper {dsviper.version()} | query language matrix\n")
print("=== A. server compiler — tagged tree on in-memory Graph ===")

test("scan all", lambda: _eq(len(run({"attachment": VIS_ID()})["rows"]), 5))

test("where eq",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "eq", "path": "value", "value": 2}})["rows"]),
                 [2, 2]))
test("where gte",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "gte", "path": "value", "value": 3}})["rows"]),
                 [3, 5]))
test("where in",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "in", "path": "value", "value": [1, 5]}})["rows"]),
                 [1, 5]))
test("where and",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "and", "args": [
         {"op": "gte", "path": "value", "value": 2}, {"op": "lt", "path": "value", "value": 5}]}})["rows"]), [2, 2, 3]))
test("where or",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "or", "args": [
         {"op": "eq", "path": "value", "value": 1}, {"op": "eq", "path": "value", "value": 5}]}})["rows"]), [1, 5]))
test("where not",
     lambda: _eq(vals(
         run({"attachment": VIS_ID(), "where": {"op": "not", "arg": {"op": "eq", "path": "value", "value": 2}}})[
             "rows"]), [1, 3, 5]))
test("where nested path (color.red gt)",
     lambda: _eq(vals(run({"attachment": VIS_ID(), "where": {"op": "gt", "path": "color.red", "value": 0.25}})["rows"]),
                 [3, 5]))
test("where exists",
     lambda: _eq(len(run({"attachment": VIS_ID(), "where": {"op": "exists", "path": "color", "value": True}})["rows"]),
                 5))
test("where missing field -> empty",
     lambda: _eq(len(run({"attachment": VIS_ID(), "where": {"op": "eq", "path": "nope", "value": 1}})["rows"]), 0))

test("orderBy asc",
     lambda: _eq([r["document"]["value"] for r in run({"attachment": VIS_ID(), "orderBy": ["value"]})["rows"]],
                 [1, 2, 2, 3, 5]))
test("orderBy desc + limit",
     lambda: _eq([r["document"]["value"] for r in
                  run({"attachment": VIS_ID(), "orderBy": [{"path": "value", "desc": True}], "limit": 2})["rows"]],
                 [5, 3]))
test("skip + limit on ordered",
     lambda: _eq([r["document"]["value"] for r in
                  run({"attachment": VIS_ID(), "orderBy": ["value"], "skip": 1, "limit": 2})["rows"]], [2, 2]))
test("orderBy nested path (position.x) asc + limit",
     lambda: _eq([r["document"]["position"]["x"] for r in
                  run({"attachment": V2D_ID(), "orderBy": ["position.x"], "limit": 3})["rows"]], [10.0, 20.0, 30.0]))

test("select include-list (nested preserved)",
     lambda: _eq(run({"attachment": VIS_ID(), "where": {"op": "eq", "path": "value", "value": 5},
                      "select": ["value", "color.red"]})["rows"][0]["document"], {"value": 5, "color": {"red": 0.5}}))
test("select alias-object (flat)",
     lambda: _eq(run({"attachment": VIS_ID(), "where": {"op": "eq", "path": "value", "value": 5},
                      "select": {"v": "value", "r": "color.red"}})["rows"][0]["document"], {"v": 5, "r": 0.5}))


def t_expand():
    r = run({"attachment": "Graph::Graph.topology", "expand": {"vertexKeys": V2D_ID()}})
    exp = r["rows"][0]["document"]["vertexKeys"]
    assert len(exp) == 5, len(exp)
    assert all("position" in d for d in exp), exp
    assert sorted(d["position"]["x"] for d in exp) == XS


test("expand set<key> -> docs", t_expand)


def t_pushdown_engine():
    inst = run({"attachment": VIS_ID()})["rows"][0]["key"]["instance"]
    r = run({"attachment": VIS_ID(), "where": {"op": "in", "key": "instance", "value": [inst]}})
    assert len(r["rows"]) == 1 and r["rows"][0]["key"]["instance"] == inst


test("key predicate (instance in [...])", t_pushdown_engine)


def t_cursor():
    r = run({"attachment": VIS_ID(), "cursor": True, "batch": 2})
    assert len(r["rows"]) == 2 and r["hasMore"]
    seen = len(r["rows"])
    while r["hasMore"]:
        r = query.cursor_next({"cursor": r["cursor"]})
        seen += len(r["rows"])
    assert seen == 5, seen


test("cursor paging (batch 2 -> 5 total)", t_cursor)

print("\n=== B. laziness — fake getting (get() call counter) ===")


class _Opt:
    def __init__(self, v): self.v = v

    def is_nil(self): return self.v is None

    def unwrap(self, *, encoded=True): return self.v


class FakeGetting:
    def __init__(self, items):
        self._items = items
        self.get_calls = 0

    def keys(self, att): return list(self._items)

    def get(self, att, key):
        self.get_calls += 1
        return _Opt(self._items[key])


ITEMS = {f"k{i}": {"v": i} for i in range(10)}


def t_lazy_first():
    fg = FakeGetting(ITEMS)
    out = (Enumerable(rows(fg, None, encoded=False))
           .where(lambda kv: kv[1]["v"] == 3).select(lambda kv: kv[0]).first_or_default())
    assert out == "k3" and fg.get_calls == 4, (out, fg.get_calls)  # stops at the match


test("short-circuit: first fetches only up to match", t_lazy_first)


def t_lazy_take():
    fg = FakeGetting(ITEMS)
    out = Enumerable(rows(fg, None, encoded=False)).take(2).to_list()
    assert len(out) == 2 and fg.get_calls == 2, fg.get_calls


test("short-circuit: take(2) fetches 2", t_lazy_take)


def t_pushdown_zero_fetch():
    fg = FakeGetting(ITEMS)
    out = list(rows(fg, None, key_pred=lambda k: k == "k7", encoded=False))
    assert len(out) == 1 and fg.get_calls == 1, fg.get_calls  # 9 rejected keys never fetched


test("key-pushdown: rejected keys cost zero get()", t_pushdown_zero_fetch)


def t_compiler_partition():
    # key-only where -> a key_pred is produced; mixed where -> none
    kp, _ = query._compile_predicate({"op": "in", "key": "instance", "value": ["x"]}, "C")
    assert kp is not None, "key-only should push down"
    kp2, _ = query._compile_predicate({"op": "eq", "path": "value", "value": 1}, "C")
    assert kp2 is None, "doc predicate must not push down"
    kp3, dp3 = query._compile_predicate({"op": "and", "args": [
        {"op": "in", "key": "instance", "value": ["x"]}, {"op": "eq", "path": "value", "value": 1}]}, "C")
    assert kp3 is not None, "mixed and: key conjunct pushes down"


test("compiler partitions key vs doc predicates", t_compiler_partition)

print("\n=== C. real database — a built fixture ===")


def t_real_agraph():
    rdb = dsviper.CommitDatabase.open(A_GRAPH, readonly=True)
    rinsp = dsviper.DefinitionsInspector(rdb.definitions())
    rcs = dsviper.CommitStateBuilder.state(rdb, rdb.last_commit_id())
    all5 = query.run_query(rcs, rinsp, {"op": "query", "attachment": "Graph::Vertex.visualAttributes"})
    assert len(all5["rows"]) == 5, len(all5["rows"])
    v2 = query.run_query(rcs, rinsp, {"op": "query", "attachment": "Graph::Vertex.visualAttributes",
                                      "where": {"op": "eq", "path": "value", "value": 2}})
    assert all(r["document"]["value"] == 2 for r in v2["rows"]) and len(v2["rows"]) >= 1
    exp = query.run_query(rcs, rinsp, {"op": "query", "attachment": "Graph::Graph.topology",
                                       "expand": {"vertexKeys": "Graph::Vertex.render2DAttributes"}})
    assert len(exp["rows"][0]["document"]["vertexKeys"]) == 5


test("a.graph: scan / where / expand", t_real_agraph)

print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
