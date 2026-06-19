"""Query compiler: a tagged-tree query AST -> a py-linq chain over the lazy row source."""
import re
import dsviper
from py_linq import Enumerable
from source import rows

_MISSING = object()


# ---------------------------------------------------------------- path navigation
def _parse_path(path):
    out = []
    for m in re.finditer(r"([^.\[\]]+)|\[(\d+)\]", path):
        out.append(m.group(1) if m.group(1) is not None else int(m.group(2)))
    return out


def _get_path(doc, path):
    cur = doc
    for seg in _parse_path(path):
        try:
            cur = cur[seg]
        except (KeyError, IndexError, TypeError):
            return _MISSING
    return cur


def _set_path(doc, path, value):
    segs = _parse_path(path)
    cur = doc
    for seg in segs[:-1]:
        cur = cur.setdefault(seg, {})
    cur[segs[-1]] = value


# ---------------------------------------------------------------- predicate engine
_COMPARATORS = {
    "eq":  lambda a, b: a == b,
    "ne":  lambda a, b: a != b,
    "gt":  lambda a, b: a is not _MISSING and a > b,
    "gte": lambda a, b: a is not _MISSING and a >= b,
    "lt":  lambda a, b: a is not _MISSING and a < b,
    "lte": lambda a, b: a is not _MISSING and a <= b,
    "in":  lambda a, b: a in b,
    "nin": lambda a, b: a not in b,
}


def _is_key_only(node):
    op = node["op"]
    if op == "not":
        return _is_key_only(node["arg"])
    if op in ("and", "or"):
        return all(_is_key_only(a) for a in node["args"])
    return "key" in node


def _leaf_value(node, jdoc, kf):
    if "key" in node:
        return kf.get(node["key"], _MISSING)
    return _get_path(jdoc, node["path"])


def _eval(node, jdoc, kf):
    op = node["op"]
    if op == "and":
        return all(_eval(a, jdoc, kf) for a in node["args"])
    if op == "or":
        return any(_eval(a, jdoc, kf) for a in node["args"])
    if op == "not":
        return not _eval(node["arg"], jdoc, kf)
    if op == "exists":
        v = _leaf_value(node, jdoc, kf)
        return (v is not _MISSING and v is not None) == node.get("value", True)
    return _COMPARATORS[op](_leaf_value(node, jdoc, kf), node["value"])


def _key_fields(key, concept_name):
    return {"instance": dsviper.Value.dumps(key, json=True)[0], "concept": concept_name}


def _compile_predicate(where, concept_name):
    if where is None:
        return None, (lambda jdoc, key: True)

    if where.get("op") == "and":
        key_terms = [a for a in where["args"] if _is_key_only(a)]
        doc_terms = [a for a in where["args"] if not _is_key_only(a)]
    elif _is_key_only(where):
        key_terms, doc_terms = [where], []
    else:
        key_terms, doc_terms = [], [where]

    key_pred = None
    if key_terms:
        def key_pred(key):
            kf = _key_fields(key, concept_name)
            return all(_eval(t, None, kf) for t in key_terms)

    def doc_pred(jdoc, key):
        if not doc_terms:
            return True
        kf = _key_fields(key, concept_name)
        return all(_eval(t, jdoc, kf) for t in doc_terms)

    return key_pred, doc_pred


# ---------------------------------------------------------------- ordering
def _orderkey(value):
    return (1, None) if value is _MISSING else (0, value)


def _apply_order(en, order):
    specs = [{"path": o} if isinstance(o, str) else o for o in order]
    first = specs[0]
    sel = lambda kv, p=first["path"]: _orderkey(_get_path(kv[1], p))
    se = en.order_by_descending(sel) if first.get("desc") else en.order_by(sel)
    for s in specs[1:]:
        sel = lambda kv, p=s["path"]: _orderkey(_get_path(kv[1], p))
        se = se.then_by_descending(sel) if s.get("desc") else se.then_by(sel)
    return se


# ---------------------------------------------------------------- render: key / expand / select
def _wire_key(key):
    return {"instance": dsviper.Value.dumps(key, json=True)[0]}


def _is_key_ref(r):
    return isinstance(r, (list, tuple)) and len(r) == 2 and all(isinstance(x, str) for x in r)


def _resolve_ref(ref, target_att, ag):
    key = target_att.create_key(dsviper.ValueUUId(ref[0]))
    opt = ag.get(target_att, key)
    return None if opt.is_nil() else dsviper.Value.dumps(opt.unwrap(encoded=False), json=True)


def _expand_field(ref, target_att, ag):
    if _is_key_ref(ref):
        return _resolve_ref(ref, target_att, ag)
    if isinstance(ref, (list, tuple)) and ref and all(_is_key_ref(r) for r in ref):
        return [_resolve_ref(r, target_att, ag) for r in ref]
    return ref


def _project(doc, select):
    if isinstance(select, dict):
        return {alias: (None if (v := _get_path(doc, p)) is _MISSING else v)
                for alias, p in select.items()}
    out = {}
    for p in select:
        v = _get_path(doc, p)
        if v is not _MISSING:
            _set_path(out, p, v)
    return out


def _render_row(key, jdoc, ag, insp, expand, select, render_key, render_doc):
    doc = jdoc
    if expand:
        doc = dict(doc)
        for field, target_ident in expand.items():
            target_att = insp.check_attachment(target_ident)
            _set_path(doc, field, _expand_field(_get_path(doc, field), target_att, ag))
    if select:
        doc = _project(doc, select)
    return {"key": render_key(key), "document": render_doc(doc)}


# ---------------------------------------------------------------- cursor registry
_CURSORS = {}
_CURSOR_SEQ = [0]


def _new_cursor_id():
    _CURSOR_SEQ[0] += 1
    return f"cur_{_CURSOR_SEQ[0]:x}"


def _drain(cid, registry):
    it, render, batch = registry[cid]
    out = []
    for key, jdoc in it:
        out.append(render(key, jdoc))
        if len(out) >= batch:
            return {"ok": True, "cursor": cid, "rows": out, "hasMore": True}
    del registry[cid]
    return {"ok": True, "cursor": cid, "rows": out, "hasMore": False}


def cursor_next(cmd, registry=None):
    registry = _CURSORS if registry is None else registry
    cid = cmd["cursor"]
    if cid not in registry:
        return {"ok": False, "error": {"code": "Gateway:Cursor:Unknown", "message": f"no such cursor {cid!r}"}}
    return _drain(cid, registry)


def cursor_close(cmd, registry=None):
    registry = _CURSORS if registry is None else registry
    registry.pop(cmd["cursor"], None)
    return {"ok": True}


# ---------------------------------------------------------------- the entry point
def run_query(source, insp, q, *, render_key=None, render_doc=None, cursors=None):
    render_key = render_key or _wire_key
    render_doc = render_doc or (lambda d: d)
    ident = q["attachment"]
    att = insp.check_attachment(ident)
    concept_name = ident.rsplit(".", 1)[0]
    ag = source.attachment_getting()

    key_pred, doc_pred = _compile_predicate(q.get("where"), concept_name)

    def pairs():
        for key, doc in rows(ag, att, key_pred=key_pred, encoded=False):
            jdoc = dsviper.Value.dumps(doc, json=True)
            if doc_pred(jdoc, key):
                yield key, jdoc

    en = Enumerable(pairs())
    if q.get("orderBy"):
        en = _apply_order(en, q["orderBy"])
    if q.get("skip"):
        en = en.skip(q["skip"])
    if q.get("limit") is not None:
        en = en.take(q["limit"])

    expand, select = q.get("expand"), q.get("select")
    render = lambda key, jdoc: _render_row(key, jdoc, ag, insp, expand, select, render_key, render_doc)

    if q.get("cursor"):
        registry = _CURSORS if cursors is None else cursors
        cid = _new_cursor_id()
        registry[cid] = (iter(en), render, q.get("batch", 100))
        return _drain(cid, registry)

    return {"ok": True, "rows": [render(key, jdoc) for key, jdoc in en]}
