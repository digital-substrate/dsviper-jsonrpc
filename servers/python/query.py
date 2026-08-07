"""Query compiler: a tagged-tree query AST -> a lazy chain over the query layer's row source."""
import re
from functools import cmp_to_key
from itertools import islice

import dsviper
from dsviper_query import MISSING, compare_values, predicate, rows

# The query layer's own absent marker: the predicate it compiles tests against THAT
# object, so the accessor below must return the same one.
_MISSING = MISSING


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
def _is_key_only(node):
    op = node["op"]
    if op == "not":
        return _is_key_only(node["arg"])
    if op in ("and", "or"):
        return all(_is_key_only(a) for a in node["args"])
    return "key" in node


def _key_fields(key, concept_name):
    return {"instance": dsviper.Value.dumps(key, json=True)[0], "concept": concept_name}


# The query layer compiles ONE predicate over ONE object, so the object it walks is the
# (document, key-fields) pair and the two accessors open the half they need. The wire's
# own path syntax (bracketed indices) is why `field` stays this module's `_get_path`
# rather than the layer's dotted default.
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

    def with_exists_default(node):
        """This wire lets `exists` omit its operand, meaning True; the query layer's table
        reads a missing operand as False. Filled in before compiling."""
        if node["op"] in ("and", "or"):
            return dict(node, args=[with_exists_default(a) for a in node["args"]])
        if node["op"] == "not":
            return dict(node, arg=with_exists_default(node["arg"]))
        if node["op"] == "exists" and "value" not in node:
            return dict(node, value=True)
        return node

    def compile_terms(terms):
        return predicate(with_exists_default({"op": "and", "args": terms}),
                         field=lambda pair, path: _get_path(pair[0], path),
                         key_field=lambda pair, name: pair[1].get(name, _MISSING))

    key_pred = None
    if key_terms:
        test = compile_terms(key_terms)

        def key_pred(key):
            return test((None, _key_fields(key, concept_name)))

    doc_test = compile_terms(doc_terms) if doc_terms else None

    def doc_pred(jdoc, key):
        if doc_test is None:
            return True
        return doc_test((jdoc, _key_fields(key, concept_name)))

    return key_pred, doc_pred


# ---------------------------------------------------------------- ordering
def _apply_order(pairs, order):
    """Sorts on the query layer's total compare_values: a missing or nil field sorts
    last, and `desc` reverses the comparison. Materialises — a sort is a barrier."""
    specs = [{"path": o} if isinstance(o, str) else o for o in order]

    def compare(a, b):
        for spec in specs:
            va, vb = _get_path(a[1], spec["path"]), _get_path(b[1], spec["path"])
            c = compare_values(None if va is _MISSING else va,
                               None if vb is _MISSING else vb)
            if c:
                return -c if spec.get("desc") else c
        return 0

    return sorted(pairs, key=cmp_to_key(compare))


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

    chain = pairs()
    if q.get("orderBy"):
        chain = _apply_order(chain, q["orderBy"])
    if q.get("skip"):
        chain = islice(chain, q["skip"], None)
    if q.get("limit") is not None:
        chain = islice(chain, q["limit"])

    expand, select = q.get("expand"), q.get("select")
    render = lambda key, jdoc: _render_row(key, jdoc, ag, insp, expand, select, render_key, render_doc)

    if q.get("cursor"):
        registry = _CURSORS if cursors is None else cursors
        cid = _new_cursor_id()
        registry[cid] = (iter(chain), render, q.get("batch", 100))
        return _drain(cid, registry)

    return {"ok": True, "rows": [render(key, jdoc) for key, jdoc in chain]}
