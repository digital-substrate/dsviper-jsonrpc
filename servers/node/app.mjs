// The server: a faithful JSON projection of the CommitDatabase interface (+ sessions, catalog, HTTP).
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import dsviper from '@digitalsubstrate/dsviper';

import * as query from './query.mjs';
import {Unprojector} from './unproject.mjs';

/** @import * as V from '@digitalsubstrate/dsviper' */
/** @import {IncomingMessage, ServerResponse} from 'node:http' */
/** @import {Cursor, QueryRequest} from './query.mjs' */

const {
    AttachmentGetting, BlobLayout, CommitDatabase, CommitDatabaseHelper, CommitMutableState,
    CommitStateBuilder, DSMDefinitions, DefinitionsInspector, Path, Value, ValueBlob,
    ValueBlobId, ValueCommitId, ValueUUId,
} = dsviper;

const END_POSITION = new ValueUUId('00000000-0000-0000-0000-000000000000');
const ZERO_COMMIT = '0'.repeat(40);

// ---------------------------------------------------------------- wire shapes
/** A key on the wire: the instance hex, or {instance, concept?}. @typedef {string | {instance: string, concept?: string | null}} WireKey */
/** A commit to read: its hex, or 'head' / null / undefined for the last commit. @typedef {string | null | undefined} ViewSpec */
/**
 * @typedef {{type: 'Field', value: string} | {type: 'Index', value: number} | {type: 'Key', value: V.InputValue}
 *     | {type: 'Position', value: string} | {type: 'Entry', value: V.InputValue} | {type: 'Element', value: number}
 *     | {type: 'Unwrap', value?: undefined}} PathComponentSpec
 */
/** A path: dotted field names, or explicit components. @typedef {string | PathComponentSpec[]} PathSpec */
/** @typedef {string | {dataType?: string, components?: number}} LayoutSpec */
/**
 * The operand of one mutation verb. `path` is read by the verbs that take one, the
 * positions by the xarray verbs, `value` by every verb but remove_in_xarray.
 * @typedef {Object} MutationSpec
 * @property {string} attachment
 * @property {WireKey} key
 * @property {V.InputValue} value
 * @property {PathSpec} [path]
 * @property {boolean} [recursive]
 * @property {string | null} [beforePosition]
 * @property {string | null} [newPosition]
 * @property {string | null} [position]
 */
/** One mutation: {verb: operand}. @typedef {Record<string, MutationSpec>} Mutation */
/**
 * A request. An op reads only the fields it names; the ones it requires are typed as present.
 * @typedef {Object} GatewayCommandFields
 * @property {string} op
 * @property {string} [session]
 * @property {string | null} [database]
 * @property {ViewSpec} [view]
 * @property {ViewSpec} [from]
 * @property {ViewSpec} [to]
 * @property {ViewSpec} [base]
 * @property {WireKey} key
 * @property {Mutation[]} mutations
 * @property {string} [label]
 * @property {string} commitId
 * @property {string} descendant
 * @property {string} parent
 * @property {string} merged
 * @property {string} enabled
 * @property {string} disabled
 * @property {string} [anchor]
 * @property {string} [form]
 * @property {string} blobId
 * @property {string[]} blobIds
 * @property {LayoutSpec} layout
 * @property {string} data
 * @property {number} size
 * @property {number} [offset]
 * @property {string} streamId
 * @property {string} cursor
 */
/** @typedef {GatewayCommandFields & QueryRequest} Command */
/** @typedef {{code: string, message: string}} WireError */
/** A reply: ok, and either the op's fields or an error. @typedef {{ok: boolean, error?: WireError} & Record<string, unknown>} Reply */
/**
 * @typedef {Object} Catalog
 * @property {() => string[]} names
 * @property {(name: string) => V.CommitDatabase} open
 */

export class GatewayError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * @param {string} message
 * @returns {string | null}
 */
function viperCode(message) {
    if (message.startsWith('[') && message.includes(']')) {
        const parts = message.split(':');
        if (parts.length >= 5) return parts.slice(1, 4).join(':');
    }
    return null;
}

// A stand-in for difflib.get_close_matches: longest-common-subsequence ratio,
// same cutoff (0.6) and same cap (3), best first.
/**
 * @param {string} word
 * @param {string[]} candidates
 * @param {number} [cutoff]
 * @param {number} [n]
 * @returns {string[]}
 */
function closeMatches(word, candidates, cutoff = 0.6, n = 3) {
    const ratio = (/** @type {string} */ a, /** @type {string} */ b) => {
        /** @type {number[][]} */
        const rows = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                rows[i][j] = a[i - 1] === b[j - 1]
                    ? rows[i - 1][j - 1] + 1
                    : Math.max(rows[i - 1][j], rows[i][j - 1]);
        return a.length + b.length === 0 ? 1 : (2 * rows[a.length][b.length]) / (a.length + b.length);
    };
    return candidates
        .map((c) => /** @type {[number, string]} */ ([ratio(word, c), c]))
        .filter(([r]) => r >= cutoff)
        .sort((x, y) => y[0] - x[0])
        .slice(0, n)
        .map(([, c]) => c);
}

export class Gateway {
    /** @param {V.CommitDatabase} db */
    constructor(db) {
        this.db = db;
        this.defs = db.definitions();
        this.insp = new DefinitionsInspector(this.defs);
        this.unproj = new Unprojector(this.insp);
        /** @type {Map<string, Cursor>} */
        this._cursors = new Map();
        /** @type {Map<string, V.BlobStream>} */
        this._streams = new Map();
        this._streamSeq = 0;
    }

    // ---------------------------------------------------------------- resolution helpers
    /**
     * @param {string} ident
     * @returns {V.Attachment}
     */
    _att(ident) {
        try {
            return this.insp.checkAttachment(ident);
        } catch {
            const hint = closeMatches(String(ident), [...this.insp.attachmentIdentifiers()].sort());
            const suggest = hint.length ? ` Did you mean ${JSON.stringify(hint)}?` : '';
            throw new GatewayError('Gateway:Attachment:Unknown',
                `unknown attachment ${JSON.stringify(ident)}.${suggest}`);
        }
    }

    /**
     * @param {ViewSpec} view
     * @returns {V.ValueCommitId}
     */
    _commitId(view) {
        if (view === undefined || view === null || view === 'head') {
            const cid = this.db.lastCommitId();
            if (cid === undefined || cid === null) throw new Error('empty database: no head');
            return cid;
        }
        return new ValueCommitId(view);
    }

    /** @param {ViewSpec} view */
    _state(view) {
        return CommitStateBuilder.state(this.db, this._commitId(view));
    }

    /** @param {ViewSpec} base */
    _baseState(base) {
        const noHead = this.db.lastCommitId() === undefined || this.db.lastCommitId() === null;
        if ((base === undefined || base === null || base === 'head') && noHead)
            return CommitStateBuilder.initialState(this.db);
        return this._state(base);
    }

    /**
     * @param {V.Attachment} att
     * @param {WireKey} wireKey
     */
    _key(att, wireKey) {
        const instance = (wireKey !== null && typeof wireKey === 'object') ? wireKey.instance : wireKey;
        return att.createKey(new ValueUUId(instance));
    }

    /**
     * @param {PathSpec} spec
     * @returns {V.PathConst}
     */
    _path(spec) {
        let p = new Path();
        if (typeof spec === 'string') {
            for (const seg of spec.split('.')) p = p.field(seg);
            return p.const();
        }
        for (const c of spec) {
            const {type, value} = c;
            if (type === 'Field') p = p.field(value);
            else if (type === 'Index') p = p.index(value);
            else if (type === 'Key') p = p.key(value);
            else if (type === 'Position') p = p.position(new ValueUUId(value));
            else if (type === 'Entry') p = p.entry(value);
            else if (type === 'Element') p = p.element(value);
            else if (type === 'Unwrap') p = p.unwrap();
            else throw new Error(`unknown path component type ${JSON.stringify(type)}`);
        }
        return p.const();
    }

    /**
     * @param {string | null | undefined} hexOrEnd
     * @returns {V.ValueUUId}
     */
    _pos(hexOrEnd) {
        return (hexOrEnd === undefined || hexOrEnd === null || hexOrEnd === 'end')
            ? END_POSITION : new ValueUUId(hexOrEnd);
    }

    // ---------------------------------------------------------------- read
    /** @param {Command} cmd */
    op_get(cmd) {
        const att = this._att(cmd.attachment);
        const opt = this._state(cmd.view).attachmentGetting().get(att, this._key(att, cmd.key));
        if (opt.isNil()) return {ok: true, value: null};
        return {ok: true, value: this.unproj.value(Value.dumps(/** @type {V.Value} */ (opt.unwrap(false)), true))};
    }

    /** @param {Command} cmd */
    op_has(cmd) {
        const att = this._att(cmd.attachment);
        return {ok: true, has: this._state(cmd.view).attachmentGetting().has(att, this._key(att, cmd.key))};
    }

    /** @param {Command} cmd */
    op_keys(cmd) {
        const att = this._att(cmd.attachment);
        const ag = this._state(cmd.view).attachmentGetting();
        return {ok: true, keys: [...ag.keys(att)].map((k) => this.unproj.key(/** @type {V.ValueKey} */ (k)))};
    }

    /** @param {Command} cmd */
    op_query(cmd) {
        return query.runQuery(this._state(cmd.view), this.insp, cmd, {
            renderKey: (k) => this.unproj.key(k),
            renderDoc: (d) => this.unproj.value(d),
            cursors: this._cursors,
        });
    }

    /** @param {Command} cmd */
    op_cursorNext(cmd) {
        return query.cursorNext(cmd, this._cursors);
    }

    /** @param {Command} cmd */
    op_cursorClose(cmd) {
        return query.cursorClose(cmd, this._cursors);
    }

    /** @param {Command} cmd */
    op_diffKeys(cmd) {
        const att = this._att(cmd.attachment);
        const ag1 = this._state(cmd.from).attachmentGetting();
        const ag2 = this._state(cmd.to).attachmentGetting();
        const [added, removed, different, same] = AttachmentGetting.diffKeys(ag1, ag2, att);
        const render = (/** @type {V.ValueSet} */ set) => [...set].map((k) => this.unproj.key(/** @type {V.ValueKey} */ (k)));
        return {
            ok: true,
            added: render(added),
            removed: render(removed),
            different: render(different),
            same: render(same),
        };
    }

    // ---------------------------------------------------------------- write — the eleven verbs
    /** @param {Command} cmd */
    op_commit(cmd) {
        const ms = new CommitMutableState(this._baseState(cmd.base ?? 'head'));
        const am = ms.attachmentMutating();
        for (const m of cmd.mutations) {
            const [verb, spec] = Object.entries(m)[0];
            this._applyVerb(am, verb, spec);
        }
        const created = this.db.commitMutations(cmd.label ?? 'commit', ms);
        /** @type {{ok: boolean, commitId: string, heads?: string[]}} */
        const result = {ok: true, commitId: String(created)};
        const heads = [...this.db.headCommitIds()].map(String);
        if (heads.length > 1) result.heads = heads;
        return result;
    }

    /**
     * @param {V.AttachmentMutating} am
     * @param {string} verb
     * @param {MutationSpec} spec
     */
    _applyVerb(am, verb, spec) {
        const att = this._att(spec.attachment);
        const key = this._key(att, spec.key);
        const v = spec.value;
        // read only by the verbs that take a path, which the wire sends with one
        const path = () => this._path(/** @type {PathSpec} */ (spec.path));
        switch (verb) {
            case 'set': return am.set(att, key, v);
            case 'diff': return 'recursive' in spec
                ? am.diff(att, key, v, spec.recursive) : am.diff(att, key, v);
            case 'update': return am.update(att, key, path(), v);
            case 'union_in_set': return am.unionInSet(att, key, path(), v);
            case 'subtract_in_set': return am.subtractInSet(att, key, path(), v);
            case 'union_in_map': return am.unionInMap(att, key, path(), v);
            case 'subtract_in_map': return am.subtractInMap(att, key, path(), v);
            case 'update_in_map': return am.updateInMap(att, key, path(), v);
            case 'insert_in_xarray': return am.insertInXarray(
                att, key, path(), this._pos(spec.beforePosition), this._pos(spec.newPosition), v);
            case 'update_in_xarray': return am.updateInXarray(att, key, path(), this._pos(spec.position), v);
            case 'remove_in_xarray': return am.removeInXarray(att, key, path(), this._pos(spec.position));
            default:
                throw new GatewayError('Gateway:Verb:Unknown', `unknown mutation verb ${JSON.stringify(verb)}`);
        }
    }

    // ---------------------------------------------------------------- DAG navigation (read)
    op_heads() {
        return {ok: true, heads: [...this.db.headCommitIds()].map(String)};
    }

    op_commitIds() {
        return {ok: true, commitIds: [...this.db.commitIds()].map(String)};
    }

    /** @param {Command} cmd */
    op_commitExists(cmd) {
        return {ok: true, exists: this.db.commitExists(new ValueCommitId(cmd.commitId))};
    }

    /** @param {Command} cmd */
    op_children(cmd) {
        return {ok: true, commitIds: [...this.db.childrenCommitIds(new ValueCommitId(cmd.commitId))].map(String)};
    }

    /** @param {Command} cmd */
    op_nephews(cmd) {
        return {ok: true, commitIds: [...this.db.nephewCommitIds(new ValueCommitId(cmd.commitId))].map(String)};
    }

    op_firstCommitId() {
        const c = this.db.firstCommitId();
        return {ok: true, commitId: c ? String(c) : null};
    }

    op_lastCommitId() {
        const c = this.db.lastCommitId();
        return {ok: true, commitId: c ? String(c) : null};
    }

    /** @param {Command} cmd */
    op_commitHeader(cmd) {
        const h = this.db.commitHeader(new ValueCommitId(cmd.commitId));
        const target = String(h.targetCommitId());
        return {
            ok: true,
            header: {
                commitId: String(h.commitId()),
                parent: String(h.parentCommitId()),
                timestamp: h.timestamp(),
                label: h.label(),
                target: target === ZERO_COMMIT ? null : target,
            },
        };
    }

    /** @param {Command} cmd */
    op_isAncestor(cmd) {
        return {
            ok: true,
            isAncestor: this.db.isAncestor(new ValueCommitId(cmd.commitId), new ValueCommitId(cmd.descendant)),
        };
    }

    /** @param {Command} cmd */
    op_isMergeable(cmd) {
        return {
            ok: true,
            isMergeable: this.db.isMergeable(new ValueCommitId(cmd.parent), new ValueCommitId(cmd.merged)),
        };
    }

    // ---------------------------------------------------------------- DAG operations (write -> a CommitId)
    /** @param {Command} cmd */
    op_mergeCommit(cmd) {
        const c = this.db.mergeCommit(cmd.label ?? 'merge',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.merged));
        return {ok: true, commitId: String(c)};
    }

    /** @param {Command} cmd */
    op_enableCommit(cmd) {
        const c = this.db.enableCommit(cmd.label ?? 'enable',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.enabled));
        return {ok: true, commitId: String(c)};
    }

    /** @param {Command} cmd */
    op_disableCommit(cmd) {
        const c = this.db.disableCommit(cmd.label ?? 'disable',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.disabled));
        return {ok: true, commitId: String(c)};
    }

    /** @param {Command} cmd */
    op_reduceHeads(cmd) {
        const c = cmd.anchor
            ? CommitDatabaseHelper.reduceHeads(this.db, new ValueCommitId(cmd.anchor))
            : CommitDatabaseHelper.reduceHeads(this.db);
        return {ok: true, commitId: c ? String(c) : null};
    }

    /** @param {Command} cmd */
    op_forward(cmd) {
        const c = CommitDatabaseHelper.forward(this.db, new ValueCommitId(cmd.commitId));
        return {ok: true, commitId: c ? String(c) : null};
    }

    /** @param {Command} cmd */
    op_fastForward(cmd) {
        const c = CommitDatabaseHelper.fastForward(this.db, new ValueCommitId(cmd.commitId));
        return {ok: true, commitId: c ? String(c) : null};
    }

    // ---------------------------------------------------------------- schema
    /** @param {Command} cmd */
    op_schema(cmd) {
        const dsm = DSMDefinitions.fromDefinitions(this.defs);
        if (cmd.form === 'json') return {ok: true, json: JSON.parse(dsm.toJsonString())};
        return {ok: true, dsm: dsm.toDsm()};
    }

    // ---------------------------------------------------------------- blobs (JSON plane: metadata + base64)
    /** @param {LayoutSpec} spec */
    _layout(spec) {
        if (typeof spec === 'string') return BlobLayout.parse(spec);
        return new BlobLayout(spec.dataType ?? 'uchar', spec.components ?? 1);
    }

    op_blobStatistics() {
        const st = this.db.blobStatistics();
        return {
            ok: true, count: st.count(), totalSize: st.totalSize(),
            minSize: st.minSize(), maxSize: st.maxSize(),
        };
    }

    op_blobIds() {
        return {ok: true, blobIds: [...this.db.blobIds()].map(String)};
    }

    /** @param {Command} cmd */
    op_blobInfo(cmd) {
        const info = /** @type {V.BlobInfo} */ (this.db.blobInfo(/** @type {V.ValueBlobId} */ (ValueBlobId.tryParse(cmd.blobId))));
        return {
            ok: true, blobId: String(info.blobId()), size: info.size(),
            layout: info.blobLayout().representation(), chunked: info.chunked(), rowId: info.rowId(),
        };
    }

    /** @param {Command} cmd */
    op_unknownBlobIds(cmd) {
        const have = new Set([...this.db.blobIds()].map(String));
        return {ok: true, unknown: cmd.blobIds.filter((b) => !have.has(b))};
    }

    /** @param {Command} cmd */
    op_createBlob(cmd) {
        const bid = this.db.createBlob(this._layout(cmd.layout), ValueBlob.base64Decode(cmd.data));
        return {ok: true, blobId: String(bid)};
    }

    /** @param {Command} cmd */
    op_blob(cmd) {
        const vb = /** @type {V.ValueBlob} */ (this.db.blob(/** @type {V.ValueBlobId} */ (ValueBlobId.tryParse(cmd.blobId))));
        return {ok: true, data: vb.base64Encode(), size: vb.size()};
    }

    /** @param {Command} cmd */
    op_readBlob(cmd) {
        const vb = this.db.readBlob(/** @type {V.ValueBlobId} */ (ValueBlobId.tryParse(cmd.blobId)), cmd.size, cmd.offset ?? 0);
        return {ok: true, data: vb.base64Encode()};
    }

    /** @param {Command} cmd */
    op_blobStreamCreate(cmd) {
        this._streamSeq += 1;
        const sid = `blob_${this._streamSeq.toString(16)}`;
        this._streams.set(sid, this.db.blobStreamCreate(this._layout(cmd.layout), cmd.size));
        return {ok: true, streamId: sid};
    }

    /** @param {string} sid */
    _stream(sid) {
        const s = this._streams.get(sid);
        if (s === undefined)
            throw new GatewayError('Gateway:Stream:Unknown', `no such blob stream ${JSON.stringify(sid)}`);
        return s;
    }

    /** @param {Command} cmd */
    op_blobStreamAppend(cmd) {
        const s = this._stream(cmd.streamId);
        this.db.blobStreamAppend(s, ValueBlob.base64Decode(cmd.data));
        return {ok: true, offset: s.offset(), remaining: s.remaining()};
    }

    /** @param {Command} cmd */
    op_blobStreamClose(cmd) {
        const s = this._stream(cmd.streamId);
        const bid = this.db.blobStreamClose(s);
        this._streams.delete(cmd.streamId);
        return {ok: true, blobId: String(bid)};
    }

    /** @param {Command} cmd */
    op_blobStreamDelete(cmd) {
        this._streams.delete(cmd.streamId);
        return {ok: true};
    }

    // ---------------------------------------------------------------- dispatch
    /**
     * @param {Command} cmd
     * @returns {Reply}
     */
    execute(cmd) {
        const op = cmd.op;
        const handler = typeof op === 'string'
            ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this))[`op_${op}`] : undefined;
        if (typeof handler !== 'function')
            return {ok: false, error: {code: 'Gateway:Op:Unknown', message: `unknown op ${JSON.stringify(op)}`}};
        try {
            return handler.call(this, cmd);
        } catch (e) {
            if (e instanceof GatewayError) return {ok: false, error: {code: e.code, message: e.message}};
            const message = e?.message ?? String(e);
            return {ok: false, error: {code: viperCode(message) ?? 'Gateway:Internal:Error', message}};
        }
    }
}

// ---------------------------------------------------------------- sessions
export class Session {
    /**
     * @param {string} token
     * @param {V.CommitDatabase} db
     * @param {string} name
     */
    constructor(token, db, name) {
        this.token = token;
        this.db = db;
        this.name = name;
        this.gw = new Gateway(db);
    }

    close() {
        this.gw._cursors.clear();
        this.gw._streams.clear();
        try {
            this.db.close();
        } catch {
            // a database already closed elsewhere is not an error to report here
        }
    }
}

/** @implements {Catalog} */
export class DirectoryCatalog {
    /**
     * @param {string} baseDir
     * @param {boolean} [readonly]
     */
    constructor(baseDir, readonly = false) {
        this.baseDir = baseDir;
        this.readonly = readonly;
    }

    // A name designates a plain file directly inside baseDir. basename() rejects
    // the separators; realpath() rejects the symlink, which passes every syntactic
    // check and still leaves the directory. Both entry points resolve here, so a
    // name that names() lists is a name open() accepts.
    /**
     * @param {string} name
     * @returns {string | null}
     */
    _resolve(name) {
        if (!name || path.basename(name) !== name || name === '.' || name === '..') return null;
        const base = fs.realpathSync(this.baseDir);
        let p;
        try {
            p = fs.realpathSync(path.join(base, name));
        } catch {
            return null;
        }
        const inside = p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
        return inside ? p : null;
    }

    /** @returns {string[]} */
    names() {
        /** @type {string[]} */
        const out = [];
        for (const f of fs.readdirSync(this.baseDir).sort()) {
            const p = this._resolve(f);
            if (p && fs.statSync(p).isFile() && CommitDatabase.isCompatible(p)) out.push(f);
        }
        return out;
    }

    /** @param {string} name */
    open(name) {
        const p = this._resolve(name);
        if (p === null) throw new Error(`invalid database name ${JSON.stringify(name)}`);
        if (!(fs.statSync(p).isFile() && CommitDatabase.isCompatible(p)))
            throw new Error(`no compatible database ${JSON.stringify(name)}`);
        return CommitDatabase.open(p, this.readonly);
    }
}

/** @implements {Catalog} */
export class MapCatalog {
    /**
     * @param {Record<string, string>} mapping name -> file path
     * @param {boolean} [readonly]
     */
    constructor(mapping, readonly = false) {
        this.mapping = new Map(Object.entries(mapping));
        this.readonly = readonly;
    }

    names() {
        return [...this.mapping.entries()]
            .filter(([, p]) => CommitDatabase.isCompatible(p))
            .map(([n]) => n)
            .sort();
    }

    /** @param {string} name */
    open(name) {
        if (!this.mapping.has(name)) throw new Error(`no database ${JSON.stringify(name)}`);
        return CommitDatabase.open(/** @type {string} */ (this.mapping.get(name)), this.readonly);
    }
}

// One db handle per session. Python needs a per-session lock because
// ThreadingHTTPServer serves each request on its own thread; here the event loop
// already serialises them and every binding call is synchronous, so the critical
// section is the handler itself.
export class SessionManager {
    /**
     * @param {Catalog} catalog
     * @param {string | null} [defaultName]
     * @param {number} [maxSessions]
     */
    constructor(catalog, defaultName = null, maxSessions = 1024) {
        this.catalog = catalog;
        this.default = defaultName;
        /** @type {Map<string | undefined, Session>} */
        this.sessions = new Map();
        this._seq = 0;
        this._max = maxSessions;
    }

    op_databases() {
        return {ok: true, databases: this.catalog.names()};
    }

    /** @param {Command} cmd */
    op_connect(cmd) {
        const name = cmd.database ?? this.default;
        if (name === null || name === undefined)
            return {ok: false, error: {code: 'Gateway:Database:Required', message: "connect needs a 'database'"}};
        let db;
        try {
            db = this.catalog.open(name);
        } catch (e) {
            return {
                ok: false,
                error: {
                    code: 'Gateway:Database:Unknown',
                    message: `cannot open ${JSON.stringify(name)}: ${e?.message ?? e}`,
                },
            };
        }
        if (this.sessions.size >= this._max) {
            db.close();
            return {ok: false, error: {code: 'Gateway:Session:Limit', message: 'too many sessions'}};
        }
        this._seq += 1;
        const token = `s${this._seq.toString(16)}`;
        this.sessions.set(token, new Session(token, db, name));
        return {ok: true, session: token, database: name, version: '0'};
    }

    /** @param {Command} cmd */
    op_disconnect(cmd) {
        const sess = this.sessions.get(cmd.session);
        if (sess) {
            this.sessions.delete(cmd.session);
            sess.close();
        }
        return {ok: true};
    }

    /**
     * @param {Command} cmd
     * @returns {Reply}
     */
    execute(cmd) {
        const op = cmd.op;
        if (op === 'databases') return this.op_databases();
        if (op === 'connect' || op === 'hello') return this.op_connect(cmd);
        if (op === 'disconnect') return this.op_disconnect(cmd);
        const session = this.sessions.get(cmd.session);
        if (session === undefined)
            return {
                ok: false,
                error: {
                    code: 'Gateway:Session:Required',
                    message: 'this op requires a session (connect first)',
                },
            };
        return session.gw.execute(cmd);
    }
}

// ---------------------------------------------------------------- HTTP server (one db handle per session)
/**
 * @param {Catalog} catalog
 * @param {string | null} [defaultName]
 * @param {number} [port]
 */
export function serve(catalog, defaultName = null, port = 8787) {
    const mgr = new SessionManager(catalog, defaultName);

    const server = createServer((/** @type {IncomingMessage} */ req, /** @type {ServerResponse} */ res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            let out;
            try {
                const cmd = /** @type {Command} */ (JSON.parse(Buffer.concat(chunks).toString('utf8')));
                const token = req.headers['x-session'];
                if (token && !('session' in cmd)) cmd.session = /** @type {string} */ (token);
                out = Buffer.from(JSON.stringify(mgr.execute(cmd)));
            } catch (e) {
                out = Buffer.from(JSON.stringify({
                    ok: false,
                    error: {code: 'Gateway:Request:Malformed', message: e?.message ?? String(e)},
                }));
            }
            res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': out.length});
            res.end(out);
        });
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`server up: dsviper ${dsviper.version().join('.')}, multi-session `
            + `(one db handle per session), http://127.0.0.1:${port}/execute`);
    });
    return server;
}

/** @implements {Catalog} */
class SharedCatalog {
    /**
     * @param {V.CommitDatabase} db
     * @param {string} [name]
     */
    constructor(db, name = 'memory') {
        this._db = db;
        this._name = name;
    }

    names() {
        return [this._name];
    }

    open() {
        return this._db;
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    const directory = process.env.GATEWAY_DB_DIR;
    const dbPath = process.env.GATEWAY_DB;
    if (directory) serve(new DirectoryCatalog(directory));
    else if (dbPath) serve(new MapCatalog({[path.basename(dbPath)]: dbPath}), path.basename(dbPath));
    else serve(new SharedCatalog(CommitDatabase.createInMemory()), 'memory');
}
