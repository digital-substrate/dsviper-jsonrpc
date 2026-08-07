// Query compiler: a tagged-tree query AST -> a lazy chain over the lazy row source.
import dsviper from '@digitalsubstrate/dsviper';

import {rows} from './source.mjs';

const {Value} = dsviper;

const MISSING = Symbol('missing');

// ---------------------------------------------------------------- path navigation
const PATH_RE = /([^.[\]]+)|\[(\d+)\]/g;

function parsePath(path) {
    const out = [];
    for (const m of String(path).matchAll(PATH_RE))
        out.push(m[1] !== undefined ? m[1] : Number(m[2]));
    return out;
}

function getPath(doc, path) {
    let cur = doc;
    for (const seg of parsePath(path)) {
        if (cur === null || cur === undefined) return MISSING;
        if (typeof seg === 'number') {
            if (!Array.isArray(cur) && typeof cur !== 'string') return MISSING;
            if (seg >= cur.length) return MISSING;
        } else if (typeof cur !== 'object' || Array.isArray(cur) || !(seg in cur)) {
            return MISSING;
        }
        cur = cur[seg];
    }
    return cur;
}

function setPath(doc, path, value) {
    const segs = parsePath(path);
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
        if (cur[seg] === undefined) cur[seg] = {};
        cur = cur[seg];
    }
    cur[segs[segs.length - 1]] = value;
}

// ---------------------------------------------------------------- value semantics
// Duck-typed on the runtime's total relations, the way the dsviper-query packages do
// it: a wrapped Viper value rides its own .equals() / .compare() (total and trans-type
// since 1.2.18), anything else falls back to native semantics. Documents are dumped to
// JSON before the predicate runs, so the native branch is what executes today — the
// wrapped branches keep this predicate correct for a caller that filters over values
// instead of dumped documents.
//
// The native fallback is a STRUCTURAL comparison, not the packages' canonicalKey
// token: that token folds every non-scalar to 'obj:' + String(value), which would make
// {a: 1} and {b: 2} compare equal. It is built to key a Map/Set on scalars and wrapped
// values, and the wire's operands are decoded JSON containers.
function deepEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object'
        && !Array.isArray(a) && !Array.isArray(b)) {
        const ka = Object.keys(a), kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
    }
    return false;
}

function valuesEqual(a, b) {
    if (a !== null && a !== undefined && typeof a.equals === 'function') return a.equals(b);
    if (b !== null && b !== undefined && typeof b.equals === 'function') return b.equals(a);
    return deepEqual(a, b);
}

const isNil = (v) => v === null || v === undefined || v === MISSING;

// Total by construction: a nil sorts last, so a collection with missing or optional
// fields still orders coherently. Among present values, a wrapped value rides the
// runtime's total .compare(); a native pair rides < >.
function compareValues(a, b) {
    if (isNil(a) || isNil(b)) return isNil(a) && isNil(b) ? 0 : (isNil(a) ? 1 : -1);
    if (typeof a.compare === 'function') return Math.sign(a.compare(b));
    if (typeof b.compare === 'function') return -Math.sign(b.compare(a));
    return a < b ? -1 : a > b ? 1 : 0;
}

const contains = (haystack, needle) =>
    typeof haystack === 'string' ? haystack.includes(needle)
        : Array.isArray(haystack) ? haystack.some((x) => valuesEqual(x, needle))
            : false;

// An order comparison requires the field to be PRESENT and non-nil, decoupled from
// compareValues' total order (where nils sort last) — so `value > 5` excludes a
// document without the field rather than treating its absence as a large value.
const COMPARATORS = {
    eq: (a, b) => valuesEqual(a, b),
    ne: (a, b) => !valuesEqual(a, b),
    gt: (a, b) => !isNil(a) && compareValues(a, b) > 0,
    gte: (a, b) => !isNil(a) && compareValues(a, b) >= 0,
    lt: (a, b) => !isNil(a) && compareValues(a, b) < 0,
    lte: (a, b) => !isNil(a) && compareValues(a, b) <= 0,
    in: (a, b) => contains(b, a),
    nin: (a, b) => !contains(b, a),
};

function isKeyOnly(node) {
    const op = node.op;
    if (op === 'not') return isKeyOnly(node.arg);
    if (op === 'and' || op === 'or') return node.args.every(isKeyOnly);
    return 'key' in node;
}

function leafValue(node, jdoc, kf) {
    if ('key' in node) return node.key in kf ? kf[node.key] : MISSING;
    return getPath(jdoc, node.path);
}

function evaluate(node, jdoc, kf) {
    const op = node.op;
    if (op === 'and') return node.args.every((a) => evaluate(a, jdoc, kf));
    if (op === 'or') return node.args.some((a) => evaluate(a, jdoc, kf));
    if (op === 'not') return !evaluate(node.arg, jdoc, kf);
    if (op === 'exists') {
        const v = leafValue(node, jdoc, kf);
        return (v !== MISSING && v !== null) === (node.value ?? true);
    }
    const comparator = COMPARATORS[op];
    if (comparator === undefined) throw new Error(`unknown predicate op ${JSON.stringify(op)}`);
    return comparator(leafValue(node, jdoc, kf), node.value);
}

function keyFields(key, conceptName) {
    return {instance: Value.dumps(key, true)[0], concept: conceptName};
}

function compilePredicate(where, conceptName) {
    if (where === undefined || where === null) return [null, () => true];

    let keyTerms, docTerms;
    if (where.op === 'and') {
        keyTerms = where.args.filter(isKeyOnly);
        docTerms = where.args.filter((a) => !isKeyOnly(a));
    } else if (isKeyOnly(where)) {
        [keyTerms, docTerms] = [[where], []];
    } else {
        [keyTerms, docTerms] = [[], [where]];
    }

    const keyPred = keyTerms.length === 0 ? null : (key) => {
        const kf = keyFields(key, conceptName);
        return keyTerms.every((t) => evaluate(t, null, kf));
    };

    const docPred = (jdoc, key) => {
        if (docTerms.length === 0) return true;
        const kf = keyFields(key, conceptName);
        return docTerms.every((t) => evaluate(t, jdoc, kf));
    };

    return [keyPred, docPred];
}

// ---------------------------------------------------------------- ordering
// `desc` reverses the whole comparison — the ordering the Python side gets from its
// (present, value) tuple.
function applyOrder(pairs, order) {
    const specs = order.map((o) => (typeof o === 'string' ? {path: o} : o));
    const out = [...pairs];
    out.sort((x, y) => {
        for (const s of specs) {
            const c = compareValues(getPath(x[1], s.path), getPath(y[1], s.path));
            if (c !== 0) return s.desc ? -c : c;
        }
        return 0;
    });
    return out;
}

function* drop(iterable, n) {
    let i = 0;
    for (const x of iterable) {
        if (i++ < n) continue;
        yield x;
    }
}

function* take(iterable, n) {
    if (n <= 0) return;
    let i = 0;
    for (const x of iterable) {
        yield x;
        if (++i >= n) return;
    }
}

// ---------------------------------------------------------------- render: key / expand / select
function wireKey(key) {
    return {instance: Value.dumps(key, true)[0]};
}

function isKeyRef(r) {
    return Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string');
}

function resolveRef(ref, targetAttachment, attachmentGetting) {
    const key = targetAttachment.createKey(new dsviper.ValueUUId(ref[0]));
    const opt = attachmentGetting.get(targetAttachment, key);
    return opt.isNil() ? null : Value.dumps(opt.unwrap(false), true);
}

function expandField(ref, targetAttachment, attachmentGetting) {
    if (isKeyRef(ref)) return resolveRef(ref, targetAttachment, attachmentGetting);
    if (Array.isArray(ref) && ref.length > 0 && ref.every(isKeyRef))
        return ref.map((r) => resolveRef(r, targetAttachment, attachmentGetting));
    return ref;
}

function project(doc, select) {
    if (!Array.isArray(select)) {
        const out = {};
        for (const [alias, p] of Object.entries(select)) {
            const v = getPath(doc, p);
            out[alias] = v === MISSING ? null : v;
        }
        return out;
    }
    const out = {};
    for (const p of select) {
        const v = getPath(doc, p);
        if (v !== MISSING) setPath(out, p, v);
    }
    return out;
}

function renderRow(key, jdoc, ag, inspector, expand, select, renderKey, renderDoc) {
    let doc = jdoc;
    if (expand) {
        doc = {...doc};
        for (const [field, targetIdent] of Object.entries(expand)) {
            const targetAttachment = inspector.checkAttachment(targetIdent);
            setPath(doc, field, expandField(getPath(doc, field), targetAttachment, ag));
        }
    }
    if (select) doc = project(doc, select);
    return {key: renderKey(key), document: renderDoc(doc)};
}

// ---------------------------------------------------------------- cursor registry
const CURSORS = new Map();
let cursorSeq = 0;

function newCursorId() {
    cursorSeq += 1;
    return `cur_${cursorSeq.toString(16)}`;
}

// Pulled with next() rather than for-of: breaking out of a for-of calls the
// iterator's return(), which CLOSES a generator — the next page would then find it
// exhausted. Python's for/return leaves the iterator resumable.
function drain(cid, registry) {
    const {iterator, render, batch} = registry.get(cid);
    const out = [];
    for (;;) {
        const {value, done} = iterator.next();
        if (done) break;
        out.push(render(value[0], value[1]));
        if (out.length >= batch) return {ok: true, cursor: cid, rows: out, hasMore: true};
    }
    registry.delete(cid);
    return {ok: true, cursor: cid, rows: out, hasMore: false};
}

export function cursorNext(cmd, registry = CURSORS) {
    const cid = cmd.cursor;
    if (!registry.has(cid))
        return {ok: false, error: {code: 'Gateway:Cursor:Unknown', message: `no such cursor ${JSON.stringify(cid)}`}};
    return drain(cid, registry);
}

export function cursorClose(cmd, registry = CURSORS) {
    registry.delete(cmd.cursor);
    return {ok: true};
}

// ---------------------------------------------------------------- the entry point
export function runQuery(source, inspector, q, {renderKey = wireKey, renderDoc = (d) => d, cursors = CURSORS} = {}) {
    const ident = q.attachment;
    const attachment = inspector.checkAttachment(ident);
    const conceptName = ident.includes('.') ? ident.slice(0, ident.lastIndexOf('.')) : ident;
    const ag = source.attachmentGetting();

    const [keyPred, docPred] = compilePredicate(q.where, conceptName);

    function* pairs() {
        for (const [key, doc] of rows(ag, attachment, {keyPred, encoded: false})) {
            const jdoc = Value.dumps(doc, true);
            if (docPred(jdoc, key)) yield [key, jdoc];
        }
    }

    let chain = pairs();
    if (q.orderBy) chain = applyOrder(chain, q.orderBy);
    if (q.skip) chain = drop(chain, q.skip);
    if (q.limit !== undefined && q.limit !== null) chain = take(chain, q.limit);

    const {expand, select} = q;
    const render = (key, jdoc) => renderRow(key, jdoc, ag, inspector, expand, select, renderKey, renderDoc);

    if (q.cursor) {
        const cid = newCursorId();
        cursors.set(cid, {iterator: chain[Symbol.iterator](), render, batch: q.batch ?? 100});
        return drain(cid, cursors);
    }

    return {ok: true, rows: [...chain].map(([key, jdoc]) => render(key, jdoc))};
}
