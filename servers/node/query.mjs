// Query compiler: a tagged-tree query AST -> a lazy chain over the lazy row source.
import dsviper from '@digitalsubstrate/dsviper';
import {compareValues, predicate, rows} from '@digitalsubstrate/dsviper-query';

/** @import * as V from '@digitalsubstrate/dsviper' */

const {Value} = dsviper;

// ---------------------------------------------------------------- wire shapes
/** @typedef {'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'regex'} WhereLeafOp */
/**
 * A tagged predicate node, as the wire carries it: a junction, a negation, or a leaf that
 * tests a document path or a key field.
 * @typedef {{op: 'and' | 'or', args: WhereNode[]}
 *     | {op: 'not', arg: WhereNode}
 *     | {op: WhereLeafOp, path?: string, key?: string, value?: unknown}} WhereNode
 */
/** @typedef {string | {path: string, desc?: boolean}} OrderSpec */
/**
 * The fields a query request reads.
 * @typedef {Object} QueryRequest
 * @property {string} attachment
 * @property {WhereNode | null} [where]
 * @property {OrderSpec[]} [orderBy]
 * @property {number} [skip]
 * @property {number | null} [limit]
 * @property {Record<string, string>} [expand] field path -> the attachment its key references
 * @property {string[] | Record<string, string>} [select] paths, or alias -> path
 * @property {string | boolean} [cursor] truthy: answer one page and keep a cursor
 * @property {number} [batch]
 */
/** @typedef {{cursor: string}} CursorRequest */
/** A [key, JSON document] pair of the row stream. @typedef {[V.ValueKey, unknown]} Pair */
/** @typedef {{key: unknown, document: unknown}} Row */
/** @typedef {(key: V.ValueKey, jdoc: unknown) => Row} RowRenderer */
/** @typedef {{iterator: Iterator<Pair>, render: RowRenderer, batch: number}} Cursor */
/**
 * @typedef {Object} QueryHooks
 * @property {(key: V.ValueKey) => unknown} [renderKey]
 * @property {(doc: unknown) => unknown} [renderDoc]
 * @property {Map<string, Cursor>} [cursors]
 */

// ---------------------------------------------------------------- path navigation
const PATH_RE = /([^.[\]]+)|\[(\d+)\]/g;

/**
 * @param {string} path
 * @returns {(string | number)[]}
 */
function parsePath(path) {
    const out = [];
    for (const m of String(path).matchAll(PATH_RE))
        out.push(m[1] !== undefined ? m[1] : Number(m[2]));
    return out;
}

/**
 * @param {unknown} doc
 * @param {string} path
 * @returns {unknown}
 */
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
        cur = /** @type {Record<string | number, unknown>} */ (cur)[seg];
    }
    return cur;
}

/**
 * @param {Record<string | number, unknown>} doc
 * @param {string} path
 * @param {unknown} value
 */
function setPath(doc, path, value) {
    const segs = parsePath(path);
    let cur = doc;
    for (const seg of segs.slice(0, -1)) {
        if (cur[seg] === undefined) cur[seg] = {};
        cur = /** @type {Record<string | number, unknown>} */ (cur[seg]);
    }
    cur[segs[segs.length - 1]] = value;
}

// ---------------------------------------------------------------- predicate engine
/**
 * @param {WhereNode} node
 * @returns {boolean}
 */
function isKeyOnly(node) {
    const op = node.op;
    if (op === 'not') return isKeyOnly(node.arg);
    if (op === 'and' || op === 'or') return node.args.every(isKeyOnly);
    return 'key' in node;
}

/**
 * A key dumps to [instanceHex, conceptRuntimeIdHex].
 * @param {V.ValueKey} key
 * @param {string} conceptName
 * @returns {{instance: string, concept: string}}
 */
function keyFields(key, conceptName) {
    return {instance: /** @type {string[]} */ (Value.dumps(key, true))[0], concept: conceptName};
}

// This wire lets `exists` omit its operand, meaning true; the query layer's table reads
// a missing operand as false. Filled in before compiling so the wire keeps its meaning.
/**
 * @param {WhereNode} node
 * @returns {WhereNode}
 */
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
/**
 * @param {WhereNode | null | undefined} where
 * @param {string} conceptName
 * @returns {[((key: V.ValueKey) => boolean) | null, (jdoc: unknown, key: V.ValueKey) => boolean]}
 */
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

    /** @typedef {[unknown, Record<string, unknown>]} Subject the [document, key-fields] pair */
    /** @type {(terms: WhereNode[]) => (subject: Subject) => boolean} */
    const compileTerms = (terms) => predicate(
        // The wire node is the query package's tagged tree; predicate() refuses a malformed one.
        /** @type {import('@digitalsubstrate/dsviper-query').TaggedNode} */ (withExistsDefault({op: 'and', args: terms})),
        {
            field: (/** @type {Subject} */ pair, /** @type {string} */ path) => getPath(pair[0], path),
            keyField: (/** @type {Subject} */ pair, /** @type {string} */ name) => pair[1][name],
        });

    const keyTest = keyTerms.length ? compileTerms(keyTerms) : null;
    const docTest = docTerms.length ? compileTerms(docTerms) : null;

    const keyPred = keyTest === null ? null
        : (/** @type {V.ValueKey} */ key) => keyTest([null, keyFields(key, conceptName)]);
    const docPred = (/** @type {unknown} */ jdoc, /** @type {V.ValueKey} */ key) =>
        docTest === null ? true : docTest([jdoc, keyFields(key, conceptName)]);

    return [keyPred, docPred];
}

// ---------------------------------------------------------------- ordering
// `desc` reverses the whole comparison — the ordering the Python side gets from its
// (present, value) tuple.
/**
 * @param {Iterable<Pair>} pairs
 * @param {OrderSpec[]} order
 * @returns {Pair[]}
 */
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

/**
 * @template T
 * @param {Iterable<T>} iterable
 * @param {number} n
 * @returns {Generator<T, void, unknown>}
 */
function* drop(iterable, n) {
    let i = 0;
    for (const x of iterable) {
        if (i++ < n) continue;
        yield x;
    }
}

/**
 * @template T
 * @param {Iterable<T>} iterable
 * @param {number} n
 * @returns {Generator<T, void, unknown>}
 */
function* take(iterable, n) {
    if (n <= 0) return;
    let i = 0;
    for (const x of iterable) {
        yield x;
        if (++i >= n) return;
    }
}

// ---------------------------------------------------------------- render: key / expand / select
/**
 * @param {V.ValueKey} key
 * @returns {{instance: string}}
 */
function wireKey(key) {
    return {instance: /** @type {string[]} */ (Value.dumps(key, true))[0]};
}

/**
 * @param {unknown} r
 * @returns {r is string[]}
 */
function isKeyRef(r) {
    return Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string');
}

/**
 * @param {string[]} ref
 * @param {V.Attachment} targetAttachment
 * @param {V.AttachmentGetting} attachmentGetting
 * @returns {V.NativeValue}
 */
function resolveRef(ref, targetAttachment, attachmentGetting) {
    const key = targetAttachment.createKey(new dsviper.ValueUUId(ref[0]));
    const opt = attachmentGetting.get(targetAttachment, key);
    return opt.isNil() ? null : Value.dumps(/** @type {V.Value} */ (opt.unwrap(false)), true);
}

/**
 * @param {unknown} ref
 * @param {V.Attachment} targetAttachment
 * @param {V.AttachmentGetting} attachmentGetting
 * @returns {unknown}
 */
function expandField(ref, targetAttachment, attachmentGetting) {
    if (isKeyRef(ref)) return resolveRef(ref, targetAttachment, attachmentGetting);
    if (Array.isArray(ref) && ref.length > 0 && ref.every(isKeyRef))
        return ref.map((r) => resolveRef(r, targetAttachment, attachmentGetting));
    return ref;
}

/**
 * @param {unknown} doc
 * @param {string[] | Record<string, string>} select
 * @returns {Record<string, unknown>}
 */
function project(doc, select) {
    if (!Array.isArray(select)) {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [alias, p] of Object.entries(select)) {
            const v = getPath(doc, p);
            out[alias] = v === undefined ? null : v;
        }
        return out;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const p of select) {
        const v = getPath(doc, p);
        if (v !== undefined) setPath(out, p, v);
    }
    return out;
}

/**
 * @param {V.ValueKey} key
 * @param {unknown} jdoc
 * @param {V.AttachmentGetting} ag
 * @param {V.DefinitionsInspector} inspector
 * @param {Record<string, string> | undefined} expand
 * @param {string[] | Record<string, string> | undefined} select
 * @param {(key: V.ValueKey) => unknown} renderKey
 * @param {(doc: unknown) => unknown} renderDoc
 * @returns {Row}
 */
function renderRow(key, jdoc, ag, inspector, expand, select, renderKey, renderDoc) {
    let doc = jdoc;
    if (expand) {
        /** @type {Record<string, unknown>} */
        const expanded = {.../** @type {Record<string, unknown>} */ (doc)};
        doc = expanded;
        for (const [field, targetIdent] of Object.entries(expand)) {
            const targetAttachment = inspector.checkAttachment(targetIdent);
            setPath(expanded, field, expandField(getPath(expanded, field), targetAttachment, ag));
        }
    }
    if (select) doc = project(doc, select);
    return {key: renderKey(key), document: renderDoc(doc)};
}

// ---------------------------------------------------------------- cursor registry
/** @type {Map<string, Cursor>} */
const CURSORS = new Map();
let cursorSeq = 0;

/** @returns {string} */
function newCursorId() {
    cursorSeq += 1;
    return `cur_${cursorSeq.toString(16)}`;
}

// Pulled with next() rather than for-of: breaking out of a for-of calls the
// iterator's return(), which CLOSES a generator — the next page would then find it
// exhausted. Python's for/return leaves the iterator resumable.
/**
 * @param {string} cid a cursor the registry holds
 * @param {Map<string, Cursor>} registry
 */
function drain(cid, registry) {
    const {iterator, render, batch} = /** @type {Cursor} */ (registry.get(cid));
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

/**
 * @param {CursorRequest} cmd
 * @param {Map<string, Cursor>} [registry]
 */
export function cursorNext(cmd, registry = CURSORS) {
    const cid = cmd.cursor;
    if (!registry.has(cid))
        return {ok: false, error: {code: 'Gateway:Cursor:Unknown', message: `no such cursor ${JSON.stringify(cid)}`}};
    return drain(cid, registry);
}

/**
 * @param {CursorRequest} cmd
 * @param {Map<string, Cursor>} [registry]
 */
export function cursorClose(cmd, registry = CURSORS) {
    registry.delete(cmd.cursor);
    return {ok: true};
}

// ---------------------------------------------------------------- the entry point
/**
 * @param {V.CommitState} source
 * @param {V.DefinitionsInspector} inspector
 * @param {QueryRequest} q
 * @param {QueryHooks} [hooks]
 */
export function runQuery(source, inspector, q, {renderKey = wireKey, renderDoc = (d) => d, cursors = CURSORS} = {}) {
    const ident = q.attachment;
    const attachment = inspector.checkAttachment(ident);
    const conceptName = ident.includes('.') ? ident.slice(0, ident.lastIndexOf('.')) : ident;
    const ag = source.attachmentGetting();

    const [keyPred, docPred] = compilePredicate(q.where, conceptName);

    /** @returns {Generator<Pair, void, unknown>} */
    function* pairs() {
        for (const [key, doc] of rows(ag, attachment, {keyPred, encoded: false})) {
            const jdoc = Value.dumps(/** @type {V.Value} */ (doc), true);   // encoded: false yields Values
            if (docPred(jdoc, key)) yield [key, jdoc];
        }
    }

    /** @type {Iterable<Pair>} */
    let chain = pairs();
    if (q.orderBy) chain = applyOrder(chain, q.orderBy);
    if (q.skip) chain = drop(chain, q.skip);
    if (q.limit !== undefined && q.limit !== null) chain = take(chain, q.limit);

    const {expand, select} = q;
    /** @type {RowRenderer} */
    const render = (key, jdoc) => renderRow(key, jdoc, ag, inspector, expand, select, renderKey, renderDoc);

    if (q.cursor) {
        const cid = newCursorId();
        cursors.set(cid, {iterator: chain[Symbol.iterator](), render, batch: q.batch ?? 100});
        return drain(cid, cursors);
    }

    return {ok: true, rows: [...chain].map(([key, jdoc]) => render(key, jdoc))};
}
