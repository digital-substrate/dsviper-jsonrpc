// Query compiler: a tagged-tree query AST -> a lazy chain over the lazy row source.
import dsviper from '@digitalsubstrate/dsviper';
import {compareValues, predicate, rows} from '@digitalsubstrate/dsviper-query';

const {Value} = dsviper;

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
        if (cur === null || cur === undefined) return undefined;
        if (typeof seg === 'number') {
            if (!Array.isArray(cur) && typeof cur !== 'string') return undefined;
            if (seg >= cur.length) return undefined;
        } else if (typeof cur !== 'object' || Array.isArray(cur) || !(seg in cur)) {
            return undefined;
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

// ---------------------------------------------------------------- predicate engine
function isKeyOnly(node) {
    const op = node.op;
    if (op === 'not') return isKeyOnly(node.arg);
    if (op === 'and' || op === 'or') return node.args.every(isKeyOnly);
    return 'key' in node;
}

function keyFields(key, conceptName) {
    return {instance: Value.dumps(key, true)[0], concept: conceptName};
}

// This wire lets `exists` omit its operand, meaning true; the query layer's table reads
// a missing operand as false. Filled in before compiling so the wire keeps its meaning.
function withExistsDefault(node) {
    if (node.op === 'and' || node.op === 'or') return {...node, args: node.args.map(withExistsDefault)};
    if (node.op === 'not') return {...node, arg: withExistsDefault(node.arg)};
    if (node.op === 'exists' && node.value === undefined) return {...node, value: true};
    return node;
}

// The query layer compiles ONE predicate over ONE object, so the object it walks is the
// [document, key-fields] pair and the two accessors open the half they need. The wire's
// own path syntax (bracketed indices) is why `field` stays this module's getPath rather
// than the layer's dotted default.
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

    const compileTerms = (terms) => predicate(
        withExistsDefault({op: 'and', args: terms}),
        {field: (pair, path) => getPath(pair[0], path), keyField: (pair, name) => pair[1][name]});

    const keyTest = keyTerms.length ? compileTerms(keyTerms) : null;
    const docTest = docTerms.length ? compileTerms(docTerms) : null;

    const keyPred = keyTest === null ? null
        : (key) => keyTest([null, keyFields(key, conceptName)]);
    const docPred = (jdoc, key) =>
        docTest === null ? true : docTest([jdoc, keyFields(key, conceptName)]);

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
            out[alias] = v === undefined ? null : v;
        }
        return out;
    }
    const out = {};
    for (const p of select) {
        const v = getPath(doc, p);
        if (v !== undefined) setPath(out, p, v);
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
