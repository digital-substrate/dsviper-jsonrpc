"""The server: a faithful JSON projection of the CommitDatabase interface (+ sessions, catalog, HTTP)."""
import difflib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dsviper
import query
from unproject import Unprojector

END_POSITION = dsviper.ValueUUId("00000000-0000-0000-0000-000000000000")
ZERO_COMMIT = "0" * 40


class GatewayError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def _viper_code(message):
    if message.startswith("[") and "]" in message:
        parts = message.split(":")
        if len(parts) >= 5:
            return ":".join(parts[1:4])
    return None


class Gateway:
    def __init__(self, db):
        self.db = db
        self.defs = db.definitions()
        self.insp = dsviper.DefinitionsInspector(self.defs)
        self.unproj = Unprojector(self.insp)
        self._cursors = {}
        self._streams = {}
        self._stream_seq = 0

    # ---------------------------------------------------------------- resolution helpers
    def _att(self, ident):
        try:
            return self.insp.check_attachment(ident)
        except Exception:
            hint = difflib.get_close_matches(str(ident), sorted(self.insp.attachment_identifiers()), n=3)
            suggest = f" Did you mean {hint}?" if hint else ""
            raise GatewayError("Gateway:Attachment:Unknown", f"unknown attachment {ident!r}.{suggest}")

    def _commit_id(self, view):
        if view in (None, "head"):
            cid = self.db.last_commit_id()
            if cid is None:
                raise ValueError("empty database: no head")
            return cid
        return dsviper.ValueCommitId(view)

    def _state(self, view):
        return dsviper.CommitStateBuilder.state(self.db, self._commit_id(view))

    def _base_state(self, base):
        if base in (None, "head") and self.db.last_commit_id() is None:
            return dsviper.CommitStateBuilder.initial_state(self.db)
        return self._state(base)

    def _key(self, att, wire_key):
        inst = wire_key["instance"] if isinstance(wire_key, dict) else wire_key
        return att.create_key(dsviper.ValueUUId(inst))

    def _path(self, spec):
        p = dsviper.Path()
        if isinstance(spec, str):
            for seg in spec.split("."):
                p = p.field(seg)
            return p.const()
        for c in spec:
            t, v = c["type"], c.get("value")
            if   t == "Field":    p = p.field(v)
            elif t == "Index":    p = p.index(v)
            elif t == "Key":      p = p.key(v)
            elif t == "Position": p = p.position(dsviper.ValueUUId(v))
            elif t == "Entry":    p = p.entry(v)
            elif t == "Element":  p = p.element(v)
            elif t == "Unwrap":   p = p.unwrap()
            else: raise ValueError(f"unknown path component type {t!r}")
        return p.const()

    def _pos(self, hex_or_end):
        return END_POSITION if hex_or_end in (None, "end") else dsviper.ValueUUId(hex_or_end)

    # ---------------------------------------------------------------- read
    def op_get(self, cmd):
        att = self._att(cmd["attachment"])
        opt = self._state(cmd["view"]).attachment_getting().get(att, self._key(att, cmd["key"]))
        if opt.is_nil():
            return {"ok": True, "value": None}
        doc = dsviper.Value.dumps(opt.unwrap(encoded=False), json=True)
        return {"ok": True, "value": self.unproj.value(doc)}

    def op_has(self, cmd):
        att = self._att(cmd["attachment"])
        return {"ok": True, "has": self._state(cmd["view"]).attachment_getting().has(att, self._key(att, cmd["key"]))}

    def op_keys(self, cmd):
        att = self._att(cmd["attachment"])
        ag = self._state(cmd["view"]).attachment_getting()
        return {"ok": True, "keys": [self.unproj.key(k) for k in ag.keys(att)]}

    def op_query(self, cmd):
        return query.run_query(self._state(cmd["view"]), self.insp, cmd,
                               render_key=self.unproj.key, render_doc=self.unproj.value,
                               cursors=self._cursors)

    def op_cursorNext(self, cmd):
        return query.cursor_next(cmd, self._cursors)

    def op_cursorClose(self, cmd):
        return query.cursor_close(cmd, self._cursors)

    def op_diffKeys(self, cmd):
        att = self._att(cmd["attachment"])
        ag1 = self._state(cmd["from"]).attachment_getting()
        ag2 = self._state(cmd["to"]).attachment_getting()
        added, removed, different, same = dsviper.AttachmentGetting.diff_keys(ag1, ag2, att)
        return {"ok": True,
                "added":     [self.unproj.key(k) for k in added],
                "removed":   [self.unproj.key(k) for k in removed],
                "different": [self.unproj.key(k) for k in different],
                "same":      [self.unproj.key(k) for k in same]}

    # ---------------------------------------------------------------- write — the eleven verbs
    def op_commit(self, cmd):
        ms = dsviper.CommitMutableState(self._base_state(cmd.get("base", "head")))
        am = ms.attachment_mutating()
        for m in cmd["mutations"]:
            verb, spec = next(iter(m.items()))
            self._apply_verb(am, verb, spec)
        new = self.db.commit_mutations(cmd.get("label", "commit"), ms)
        result = {"ok": True, "commitId": str(new)}
        heads = [str(h) for h in self.db.head_commit_ids()]
        if len(heads) > 1:
            result["heads"] = heads
        return result

    def _apply_verb(self, am, verb, spec):
        att = self._att(spec["attachment"])
        key = self._key(att, spec["key"])
        v = spec.get("value")
        path = lambda: self._path(spec["path"])
        if   verb == "set":              am.set(att, key, v)
        elif verb == "diff":             am.diff(att, key, v, spec["recursive"]) if "recursive" in spec else am.diff(att, key, v)
        elif verb == "update":           am.update(att, key, path(), v)
        elif verb == "union_in_set":     am.union_in_set(att, key, path(), v)
        elif verb == "subtract_in_set":  am.subtract_in_set(att, key, path(), v)
        elif verb == "union_in_map":     am.union_in_map(att, key, path(), v)
        elif verb == "subtract_in_map":  am.subtract_in_map(att, key, path(), v)
        elif verb == "update_in_map":    am.update_in_map(att, key, path(), v)
        elif verb == "insert_in_xarray": am.insert_in_xarray(att, key, path(), self._pos(spec.get("beforePosition")), self._pos(spec["newPosition"]), v)
        elif verb == "update_in_xarray": am.update_in_xarray(att, key, path(), self._pos(spec["position"]), v)
        elif verb == "remove_in_xarray": am.remove_in_xarray(att, key, path(), self._pos(spec["position"]))
        else: raise GatewayError("Gateway:Verb:Unknown", f"unknown mutation verb {verb!r}")

    # ---------------------------------------------------------------- DAG navigation (read)
    def op_heads(self, _cmd):
        return {"ok": True, "heads": [str(h) for h in self.db.head_commit_ids()]}

    def op_commitIds(self, _cmd):
        return {"ok": True, "commitIds": [str(c) for c in self.db.commit_ids()]}

    def op_commitExists(self, cmd):
        return {"ok": True, "exists": self.db.commit_exists(dsviper.ValueCommitId(cmd["commitId"]))}

    def op_children(self, cmd):
        return {"ok": True, "commitIds": [str(c) for c in self.db.children_commit_ids(dsviper.ValueCommitId(cmd["commitId"]))]}

    def op_nephews(self, cmd):
        return {"ok": True, "commitIds": [str(c) for c in self.db.nephew_commit_ids(dsviper.ValueCommitId(cmd["commitId"]))]}

    def op_firstCommitId(self, _cmd):
        c = self.db.first_commit_id()
        return {"ok": True, "commitId": str(c) if c else None}

    def op_lastCommitId(self, _cmd):
        c = self.db.last_commit_id()
        return {"ok": True, "commitId": str(c) if c else None}

    def op_commitHeader(self, cmd):
        h = self.db.commit_header(dsviper.ValueCommitId(cmd["commitId"]))
        target = str(h.target_commit_id())
        return {"ok": True, "header": {
            "commitId": str(h.commit_id()),
            "parent": str(h.parent_commit_id()),
            "timestamp": h.timestamp(),
            "label": h.label(),
            "target": None if target == ZERO_COMMIT else target}}

    def op_isAncestor(self, cmd):
        return {"ok": True, "isAncestor": self.db.is_ancestor(
            dsviper.ValueCommitId(cmd["commitId"]), dsviper.ValueCommitId(cmd["descendant"]))}

    def op_isMergeable(self, cmd):
        return {"ok": True, "isMergeable": self.db.is_mergeable(
            dsviper.ValueCommitId(cmd["parent"]), dsviper.ValueCommitId(cmd["merged"]))}

    # ---------------------------------------------------------------- DAG operations (write -> a CommitId)
    def op_mergeCommit(self, cmd):
        c = self.db.merge_commit(cmd.get("label", "merge"),
                                 dsviper.ValueCommitId(cmd["parent"]), dsviper.ValueCommitId(cmd["merged"]))
        return {"ok": True, "commitId": str(c)}

    def op_enableCommit(self, cmd):
        c = self.db.enable_commit(cmd.get("label", "enable"),
                                  dsviper.ValueCommitId(cmd["parent"]), dsviper.ValueCommitId(cmd["enabled"]))
        return {"ok": True, "commitId": str(c)}

    def op_disableCommit(self, cmd):
        c = self.db.disable_commit(cmd.get("label", "disable"),
                                   dsviper.ValueCommitId(cmd["parent"]), dsviper.ValueCommitId(cmd["disabled"]))
        return {"ok": True, "commitId": str(c)}

    def op_reduceHeads(self, cmd):
        anchor = cmd.get("anchor")
        c = (dsviper.CommitDatabaseHelper.reduce_heads(self.db, dsviper.ValueCommitId(anchor)) if anchor
             else dsviper.CommitDatabaseHelper.reduce_heads(self.db))
        return {"ok": True, "commitId": str(c) if c else None}

    def op_forward(self, cmd):
        c = dsviper.CommitDatabaseHelper.forward(self.db, dsviper.ValueCommitId(cmd["commitId"]))
        return {"ok": True, "commitId": str(c) if c else None}

    def op_fastForward(self, cmd):
        c = dsviper.CommitDatabaseHelper.fast_forward(self.db, dsviper.ValueCommitId(cmd["commitId"]))
        return {"ok": True, "commitId": str(c) if c else None}

    # ---------------------------------------------------------------- schema
    def op_schema(self, cmd):
        dsm = dsviper.DSMDefinitions.from_definitions(self.defs)
        if cmd.get("form") == "json":
            return {"ok": True, "json": json.loads(dsm.json_encode())}
        return {"ok": True, "dsm": dsm.to_dsm()}

    # ---------------------------------------------------------------- blobs (JSON plane: metadata + base64)
    def _layout(self, spec):
        if isinstance(spec, str):
            return dsviper.BlobLayout.parse(spec)
        return dsviper.BlobLayout(spec.get("dataType", "uchar"), spec.get("components", 1))

    def op_blobStatistics(self, _cmd):
        st = self.db.blob_statistics()
        return {"ok": True, "count": st.count(), "totalSize": st.total_size(),
                "minSize": st.min_size(), "maxSize": st.max_size()}

    def op_blobIds(self, _cmd):
        return {"ok": True, "blobIds": [str(b) for b in self.db.blob_ids()]}

    def op_blobInfo(self, cmd):
        info = self.db.blob_info(dsviper.ValueBlobId.try_parse(cmd["blobId"]))
        return {"ok": True, "blobId": str(info.blob_id()), "size": info.size(),
                "layout": info.blob_layout().representation(), "chunked": info.chunked(), "rowId": info.row_id()}

    def op_unknownBlobIds(self, cmd):
        have = {str(b) for b in self.db.blob_ids()}
        return {"ok": True, "unknown": [b for b in cmd["blobIds"] if b not in have]}

    def op_createBlob(self, cmd):
        bid = self.db.create_blob(self._layout(cmd["layout"]), dsviper.ValueBlob.base64_decode(cmd["data"]))
        return {"ok": True, "blobId": str(bid)}

    def op_blob(self, cmd):
        vb = self.db.blob(dsviper.ValueBlobId.try_parse(cmd["blobId"]))
        return {"ok": True, "data": vb.base64_encode(), "size": vb.size()}

    def op_readBlob(self, cmd):
        vb = self.db.read_blob(dsviper.ValueBlobId.try_parse(cmd["blobId"]), cmd["size"], cmd.get("offset", 0))
        return {"ok": True, "data": vb.base64_encode()}

    def op_blobStreamCreate(self, cmd):
        self._stream_seq += 1
        sid = f"blob_{self._stream_seq:x}"
        self._streams[sid] = self.db.blob_stream_create(self._layout(cmd["layout"]), cmd["size"])
        return {"ok": True, "streamId": sid}

    def _stream(self, sid):
        s = self._streams.get(sid)
        if s is None:
            raise GatewayError("Gateway:Stream:Unknown", f"no such blob stream {sid!r}")
        return s

    def op_blobStreamAppend(self, cmd):
        s = self._stream(cmd["streamId"])
        self.db.blob_stream_append(s, dsviper.ValueBlob.base64_decode(cmd["data"]))
        return {"ok": True, "offset": s.offset(), "remaining": s.remaining()}

    def op_blobStreamClose(self, cmd):
        s = self._stream(cmd["streamId"])
        bid = self.db.blob_stream_close(s)
        del self._streams[cmd["streamId"]]
        return {"ok": True, "blobId": str(bid)}

    def op_blobStreamDelete(self, cmd):
        self._streams.pop(cmd["streamId"], None)
        return {"ok": True}

    # ---------------------------------------------------------------- dispatch
    def execute(self, cmd):
        op = cmd.get("op")
        handler = getattr(self, "op_" + op, None) if isinstance(op, str) else None
        if handler is None:
            return {"ok": False, "error": {"code": "Gateway:Op:Unknown", "message": f"unknown op {op!r}"}}
        try:
            return handler(cmd)
        except GatewayError as e:
            return {"ok": False, "error": {"code": e.code, "message": e.message}}
        except Exception as e:
            return {"ok": False, "error": {"code": _viper_code(str(e)) or "Gateway:Internal:Error",
                                           "message": str(e)}}


# ---------------------------------------------------------------- sessions
class Session:
    def __init__(self, token, db, name):
        self.token = token
        self.db = db
        self.name = name
        self.gw = Gateway(db)
        self.lock = threading.Lock()

    def close(self):
        self.gw._cursors.clear()
        self.gw._streams.clear()
        try:
            self.db.close()
        except Exception:
            pass


class DirectoryCatalog:
    def __init__(self, base_dir, readonly=False):
        self.base_dir = base_dir
        self.readonly = readonly

    def names(self):
        out = []
        for f in sorted(os.listdir(self.base_dir)):
            p = os.path.join(self.base_dir, f)
            if os.path.isfile(p) and dsviper.CommitDatabase.is_compatible(p):
                out.append(f)
        return out

    def open(self, name):
        if not name or os.path.basename(name) != name or name in (".", ".."):
            raise ValueError(f"invalid database name {name!r}")
        p = os.path.join(self.base_dir, name)
        if not (os.path.isfile(p) and dsviper.CommitDatabase.is_compatible(p)):
            raise FileNotFoundError(f"no compatible database {name!r}")
        return dsviper.CommitDatabase.open(p, readonly=self.readonly)


class MapCatalog:
    def __init__(self, mapping, readonly=False):
        self.mapping = dict(mapping)
        self.readonly = readonly

    def names(self):
        return sorted(n for n, p in self.mapping.items() if dsviper.CommitDatabase.is_compatible(p))

    def open(self, name):
        if name not in self.mapping:
            raise FileNotFoundError(f"no database {name!r}")
        return dsviper.CommitDatabase.open(self.mapping[name], readonly=self.readonly)


class SessionManager:
    def __init__(self, catalog, default=None, max_sessions=1024):
        self.catalog = catalog
        self.default = default
        self.sessions = {}
        self._seq = 0
        self._max = max_sessions
        self._lock = threading.Lock()

    def op_databases(self, _cmd):
        return {"ok": True, "databases": self.catalog.names()}

    def op_connect(self, cmd):
        name = cmd.get("database", self.default)
        if name is None:
            return {"ok": False, "error": {"code": "Gateway:Database:Required", "message": "connect needs a 'database'"}}
        try:
            db = self.catalog.open(name)
        except Exception as e:
            return {"ok": False, "error": {"code": "Gateway:Database:Unknown", "message": f"cannot open {name!r}: {e}"}}
        with self._lock:
            if len(self.sessions) >= self._max:
                db.close()
                return {"ok": False, "error": {"code": "Gateway:Session:Limit", "message": "too many sessions"}}
            self._seq += 1
            token = f"s{self._seq:x}"
            self.sessions[token] = Session(token, db, name)
        return {"ok": True, "session": token, "database": name, "version": "0"}

    def op_disconnect(self, cmd):
        with self._lock:
            sess = self.sessions.pop(cmd.get("session"), None)
        if sess:
            sess.close()
        return {"ok": True}

    def execute(self, cmd):
        op = cmd.get("op")
        if op == "databases":
            return self.op_databases(cmd)
        if op in ("connect", "hello"):
            return self.op_connect(cmd)
        if op == "disconnect":
            return self.op_disconnect(cmd)
        with self._lock:
            session = self.sessions.get(cmd.get("session"))
        if session is None:
            return {"ok": False, "error": {"code": "Gateway:Session:Required",
                                           "message": "this op requires a session (connect first)"}}
        with session.lock:
            return session.gw.execute(cmd)


# ---------------------------------------------------------------- HTTP server (one db handle per session)
def serve(catalog, default=None, port=8787):
    mgr = SessionManager(catalog, default)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            cmd = json.loads(body)
            token = self.headers.get("X-Session")
            if token and "session" not in cmd:
                cmd["session"] = token
            out = json.dumps(mgr.execute(cmd)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *_a):
            pass

    print(f"server up: dsviper {dsviper.version()}, multi-session (one db handle per session), "
          f"http://127.0.0.1:{port}/execute", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


class _SharedCatalog:
    def __init__(self, db, name="memory"):
        self._db, self._name = db, name
    def names(self):
        return [self._name]
    def open(self, _name):
        return self._db


if __name__ == "__main__":
    directory = os.environ.get("GATEWAY_DB_DIR")
    path = os.environ.get("GATEWAY_DB")
    if directory:
        serve(DirectoryCatalog(directory))
    elif path:
        serve(MapCatalog({os.path.basename(path): path}), default=os.path.basename(path))
    else:
        serve(_SharedCatalog(dsviper.CommitDatabase.create_in_memory()), default="memory")
