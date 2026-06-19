#!/usr/bin/env python3
"""Test matrix for server sessions: ONE CommitDatabase.open() per
session. Each session owns its handle (its own SQLite connection, never shared across threads),
its own cursor registry, and a lock. The database is chosen by NAME from a catalog (a directory
of CommitDatabase files, gated by is_compatible -- any extension); `databases` lists them (the
`show dbs` equivalent), `connect` opens one (`use`). Sessions on the same file share data.
"""
import os
import shutil
import sys
import tempfile
import uuid
import dsviper
from app import SessionManager, DirectoryCatalog
from graph_fixture import build

VIS = "Graph::Vertex.visualAttributes"

PASS, FAIL = [], []
def test(name, fn):
    try:
        fn(); PASS.append(name); print(f"  ✓ {name}")
    except Exception as e:
        FAIL.append(name); print(f"  ✗ {name}\n        {type(e).__name__}: {e}")
def eq(a, b): assert a == b, f"{a!r} != {b!r}"

# a directory of databases (any extension); plus a non-db file that must NOT be listed
TMP = tempfile.mkdtemp()
build(os.path.join(TMP, "alpha.graph"))
build(os.path.join(TMP, "beta.rapmc"))                # different extension -> still a CommitDatabase
with open(os.path.join(TMP, "notes.txt"), "w") as f:
    f.write("not a database")

mgr = SessionManager(DirectoryCatalog(TMP), default="alpha.graph")
def ex(c): return mgr.execute(c)

print(f"dsviper {dsviper.version()} | server sessions (catalog + one handle per session)\n")

def t_databases():
    r = ex({"op": "databases"})                        # the show-dbs equivalent
    assert r["ok"], r
    eq(sorted(r["databases"]), ["alpha.graph", "beta.rapmc"])   # any extension; notes.txt excluded
test("databases lists CommitDatabase files (any ext), excludes non-dbs", t_databases)

def t_connect_default():
    r = ex({"op": "connect"})
    assert r["ok"] and r["session"].startswith("s") and r["database"] == "alpha.graph", r
    ex({"op": "disconnect", "session": r["session"]})
test("connect (default database) -> token", t_connect_default)

def t_connect_choose_db():
    r = ex({"op": "connect", "database": "beta.rapmc"})
    assert r["ok"] and r["database"] == "beta.rapmc", r
    ex({"op": "disconnect", "session": r["session"]})
test("connect chooses the database by name (use)", t_connect_choose_db)

def t_connect_unknown_db():
    r = ex({"op": "connect", "database": "ghost.graph"})
    assert not r["ok"] and r["error"]["code"] == "Gateway:Database:Unknown", r
test("connect to an unknown database -> Gateway:Database:Unknown", t_connect_unknown_db)

def t_no_traversal():
    r = ex({"op": "connect", "database": "../a.graph"})  # path traversal must be rejected
    assert not r["ok"] and r["error"]["code"] == "Gateway:Database:Unknown", r
test("a traversal name is rejected", t_no_traversal)

def t_op_requires_session():
    r = ex({"op": "keys", "view": "head", "attachment": VIS})
    assert not r["ok"] and r["error"]["code"] == "Gateway:Session:Required", r
test("a data op without a session -> Gateway:Session:Required", t_op_requires_session)

def t_read_in_session():
    s = ex({"op": "connect"})["session"]
    eq(len(ex({"op": "keys", "view": "head", "attachment": VIS, "session": s})["keys"]), 5)
    ex({"op": "disconnect", "session": s})
test("read within a session (own handle)", t_read_in_session)

def t_cursor_isolation():
    s1 = ex({"op": "connect"})["session"]
    s2 = ex({"op": "connect"})["session"]
    cid = ex({"op": "query", "view": "head", "attachment": VIS, "cursor": True, "batch": 2, "session": s1})["cursor"]
    bad = ex({"op": "cursorNext", "cursor": cid, "session": s2})    # s2 cannot see s1's cursor
    assert not bad["ok"] and bad["error"]["code"] == "Gateway:Cursor:Unknown", bad
    assert ex({"op": "cursorNext", "cursor": cid, "session": s1})["ok"]
    ex({"op": "disconnect", "session": s1}); ex({"op": "disconnect", "session": s2})
test("a cursor is isolated to its session's handle", t_cursor_isolation)

def t_cross_connection_visibility():
    k = str(uuid.uuid4())
    s1 = ex({"op": "connect", "database": "beta.rapmc"})["session"]
    ex({"op": "commit", "base": "head", "label": "from s1", "session": s1, "mutations": [
        {"set": {"attachment": VIS, "key": {"instance": k},
                 "value": {"value": 7, "color": {"red": 0.0, "green": 0.0, "blue": 0.0}}}}]})
    ex({"op": "disconnect", "session": s1})
    s2 = ex({"op": "connect", "database": "beta.rapmc"})["session"]   # fresh handle, same file
    r = ex({"op": "get", "view": "head", "attachment": VIS, "key": {"instance": k}, "session": s2})
    assert r["ok"] and r["value"]["value"] == 7, r
    ex({"op": "disconnect", "session": s2})
test("commit visible across separate connections (shared file)", t_cross_connection_visibility)

def t_disconnect():
    s = ex({"op": "connect"})["session"]
    assert ex({"op": "disconnect", "session": s})["ok"]
    bad = ex({"op": "keys", "view": "head", "attachment": VIS, "session": s})
    assert not bad["ok"] and bad["error"]["code"] == "Gateway:Session:Required", bad
test("disconnect closes the handle and drops the session", t_disconnect)

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
