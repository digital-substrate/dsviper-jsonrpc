#!/usr/bin/env python3
"""Test matrix for the server blob plane: the JSON plane -- metadata
(blobInfo/blobStatistics/blobIds/unknownBlobIds) + base64 transfer (createBlob/blob/readBlob) +
the resumable, content-addressed blob stream (blobStreamCreate/Append/Close). The raw-binary
HTTP routes (GET /blob, PUT /blobStream) are a transport optimisation, deferred.
"""
import base64
import sys
import dsviper
from app import Gateway

PASS, FAIL = [], []
def test(name, fn):
    try:
        fn(); PASS.append(name); print(f"  ✓ {name}")
    except Exception as e:
        FAIL.append(name); print(f"  ✗ {name}\n        {type(e).__name__}: {e}")
def eq(a, b): assert a == b, f"{a!r} != {b!r}"

gw = Gateway(dsviper.CommitDatabase.create_in_memory())
def ex(c): return gw.execute(c)

DATA = bytes(range(16))                                 # 16 bytes = 4 RGBA pixels
B64 = base64.b64encode(DATA).decode()

print(f"dsviper {dsviper.version()} | server blob plane\n")

def t_create_and_read():
    r = ex({"op": "createBlob", "layout": "uchar-4", "data": B64})
    assert r["ok"] and len(r["blobId"]) == 40, r
    global BID
    BID = r["blobId"]
    g = ex({"op": "blob", "blobId": BID})
    eq(base64.b64decode(g["data"]), DATA); eq(g["size"], 16)
test("createBlob (base64) -> blobId ; blob -> base64 round-trip", t_create_and_read)

def t_content_addressed():
    r = ex({"op": "createBlob", "layout": "uchar-4", "data": B64})    # same content -> same id (dedup)
    eq(r["blobId"], BID)
test("content-addressed: same bytes -> same blobId", t_content_addressed)

def t_range_read():
    r = ex({"op": "readBlob", "blobId": BID, "size": 4, "offset": 8})
    eq(base64.b64decode(r["data"]), DATA[8:12])
test("readBlob (size, offset) -> range", t_range_read)

def t_info():
    r = ex({"op": "blobInfo", "blobId": BID})
    eq(r["size"], 16); eq(r["layout"], "uchar-4"); eq(r["chunked"], False); eq(r["blobId"], BID)
test("blobInfo (size/layout/chunked)", t_info)

def t_stats_and_ids():
    st = ex({"op": "blobStatistics"})
    eq(st["count"], 1); eq(st["totalSize"], 16); eq(st["minSize"], 16); eq(st["maxSize"], 16)
    ids = ex({"op": "blobIds"})
    assert BID in ids["blobIds"]
test("blobStatistics + blobIds", t_stats_and_ids)

def t_unknown_blob_ids():
    r = ex({"op": "unknownBlobIds", "blobIds": [BID, "00" * 20]})
    eq(r["unknown"], ["00" * 20])                       # only the absent one
test("unknownBlobIds (have/want)", t_unknown_blob_ids)

def t_stream():
    c = ex({"op": "blobStreamCreate", "layout": "uchar-4", "size": 16})
    sid = c["streamId"]
    a1 = ex({"op": "blobStreamAppend", "streamId": sid, "data": base64.b64encode(DATA[:8]).decode()})
    eq(a1["offset"], 8); eq(a1["remaining"], 8)
    ex({"op": "blobStreamAppend", "streamId": sid, "data": base64.b64encode(DATA[8:]).decode()})
    r = ex({"op": "blobStreamClose", "streamId": sid})
    eq(r["blobId"], BID)                                 # same content as createBlob -> same id
test("blob stream (create/append×2/close) -> content-addressed id", t_stream)

def t_stream_unknown():
    r = ex({"op": "blobStreamAppend", "streamId": "blob_ffff", "data": B64})
    assert not r["ok"] and r["error"]["code"] == "Gateway:Stream:Unknown", r
test("append to an unknown stream -> Gateway:Stream:Unknown", t_stream_unknown)

def t_stream_delete():
    c = ex({"op": "blobStreamCreate", "layout": "uchar-4", "size": 8})
    assert ex({"op": "blobStreamDelete", "streamId": c["streamId"]})["ok"]
    r = ex({"op": "blobStreamAppend", "streamId": c["streamId"], "data": B64})
    assert not r["ok"] and r["error"]["code"] == "Gateway:Stream:Unknown", r
test("blobStreamDelete aborts the stream", t_stream_delete)

print(f"\n{'=' * 52}\nPASS {len(PASS)}  /  FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
