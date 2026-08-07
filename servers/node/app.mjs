// The server: a faithful JSON projection of the CommitDatabase interface (+ sessions, catalog, HTTP).
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import dsviper from '@digitalsubstrate/dsviper';

import * as query from './query.mjs';
import {Unprojector} from './unproject.mjs';

const {
    AttachmentGetting, BlobLayout, CommitDatabase, CommitDatabaseHelper, CommitMutableState,
    CommitStateBuilder, DSMDefinitions, DefinitionsInspector, Path, Value, ValueBlob,
    ValueBlobId, ValueCommitId, ValueUUId,
} = dsviper;

const END_POSITION = new ValueUUId('00000000-0000-0000-0000-000000000000');
const ZERO_COMMIT = '0'.repeat(40);

export class GatewayError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function viperCode(message) {
    if (message.startsWith('[') && message.includes(']')) {
        const parts = message.split(':');
        if (parts.length >= 5) return parts.slice(1, 4).join(':');
    }
    return null;
}

// A stand-in for difflib.get_close_matches: longest-common-subsequence ratio,
// same cutoff (0.6) and same cap (3), best first.
function closeMatches(word, candidates, cutoff = 0.6, n = 3) {
    const ratio = (a, b) => {
        const rows = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                rows[i][j] = a[i - 1] === b[j - 1]
                    ? rows[i - 1][j - 1] + 1
                    : Math.max(rows[i - 1][j], rows[i][j - 1]);
        return a.length + b.length === 0 ? 1 : (2 * rows[a.length][b.length]) / (a.length + b.length);
    };
    return candidates
        .map((c) => [ratio(word, c), c])
        .filter(([r]) => r >= cutoff)
        .sort((x, y) => y[0] - x[0])
        .slice(0, n)
        .map(([, c]) => c);
}

export class Gateway {
    constructor(db) {
        this.db = db;
        this.defs = db.definitions();
        this.insp = new DefinitionsInspector(this.defs);
        this.unproj = new Unprojector(this.insp);
        this._cursors = new Map();
        this._streams = new Map();
        this._streamSeq = 0;
    }

    // ---------------------------------------------------------------- resolution helpers
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

    _commitId(view) {
        if (view === undefined || view === null || view === 'head') {
            const cid = this.db.lastCommitId();
            if (cid === undefined || cid === null) throw new Error('empty database: no head');
            return cid;
        }
        return new ValueCommitId(view);
    }

    _state(view) {
        return CommitStateBuilder.state(this.db, this._commitId(view));
    }

    _baseState(base) {
        const noHead = this.db.lastCommitId() === undefined || this.db.lastCommitId() === null;
        if ((base === undefined || base === null || base === 'head') && noHead)
            return CommitStateBuilder.initialState(this.db);
        return this._state(base);
    }

    _key(att, wireKey) {
        const instance = (wireKey !== null && typeof wireKey === 'object') ? wireKey.instance : wireKey;
        return att.createKey(new ValueUUId(instance));
    }

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

    _pos(hexOrEnd) {
        return (hexOrEnd === undefined || hexOrEnd === null || hexOrEnd === 'end')
            ? END_POSITION : new ValueUUId(hexOrEnd);
    }

    // ---------------------------------------------------------------- read
    op_get(cmd) {
        const att = this._att(cmd.attachment);
        const opt = this._state(cmd.view).attachmentGetting().get(att, this._key(att, cmd.key));
        if (opt.isNil()) return {ok: true, value: null};
        return {ok: true, value: this.unproj.value(Value.dumps(opt.unwrap(false), true))};
    }

    op_has(cmd) {
        const att = this._att(cmd.attachment);
        return {ok: true, has: this._state(cmd.view).attachmentGetting().has(att, this._key(att, cmd.key))};
    }

    op_keys(cmd) {
        const att = this._att(cmd.attachment);
        const ag = this._state(cmd.view).attachmentGetting();
        return {ok: true, keys: [...ag.keys(att)].map((k) => this.unproj.key(k))};
    }

    op_query(cmd) {
        return query.runQuery(this._state(cmd.view), this.insp, cmd, {
            renderKey: (k) => this.unproj.key(k),
            renderDoc: (d) => this.unproj.value(d),
            cursors: this._cursors,
        });
    }

    op_cursorNext(cmd) {
        return query.cursorNext(cmd, this._cursors);
    }

    op_cursorClose(cmd) {
        return query.cursorClose(cmd, this._cursors);
    }

    op_diffKeys(cmd) {
        const att = this._att(cmd.attachment);
        const ag1 = this._state(cmd.from).attachmentGetting();
        const ag2 = this._state(cmd.to).attachmentGetting();
        const [added, removed, different, same] = AttachmentGetting.diffKeys(ag1, ag2, att);
        const render = (set) => [...set].map((k) => this.unproj.key(k));
        return {
            ok: true,
            added: render(added),
            removed: render(removed),
            different: render(different),
            same: render(same),
        };
    }

    // ---------------------------------------------------------------- write — the eleven verbs
    op_commit(cmd) {
        const ms = new CommitMutableState(this._baseState(cmd.base ?? 'head'));
        const am = ms.attachmentMutating();
        for (const m of cmd.mutations) {
            const [verb, spec] = Object.entries(m)[0];
            this._applyVerb(am, verb, spec);
        }
        const created = this.db.commitMutations(cmd.label ?? 'commit', ms);
        const result = {ok: true, commitId: String(created)};
        const heads = this.db.headCommitIds().map(String);
        if (heads.length > 1) result.heads = heads;
        return result;
    }

    _applyVerb(am, verb, spec) {
        const att = this._att(spec.attachment);
        const key = this._key(att, spec.key);
        const v = spec.value;
        const path = () => this._path(spec.path);
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
        return {ok: true, heads: this.db.headCommitIds().map(String)};
    }

    op_commitIds() {
        return {ok: true, commitIds: this.db.commitIds().map(String)};
    }

    op_commitExists(cmd) {
        return {ok: true, exists: this.db.commitExists(new ValueCommitId(cmd.commitId))};
    }

    op_children(cmd) {
        return {ok: true, commitIds: this.db.childrenCommitIds(new ValueCommitId(cmd.commitId)).map(String)};
    }

    op_nephews(cmd) {
        return {ok: true, commitIds: this.db.nephewCommitIds(new ValueCommitId(cmd.commitId)).map(String)};
    }

    op_firstCommitId() {
        const c = this.db.firstCommitId();
        return {ok: true, commitId: c ? String(c) : null};
    }

    op_lastCommitId() {
        const c = this.db.lastCommitId();
        return {ok: true, commitId: c ? String(c) : null};
    }

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

    op_isAncestor(cmd) {
        return {
            ok: true,
            isAncestor: this.db.isAncestor(new ValueCommitId(cmd.commitId), new ValueCommitId(cmd.descendant)),
        };
    }

    op_isMergeable(cmd) {
        return {
            ok: true,
            isMergeable: this.db.isMergeable(new ValueCommitId(cmd.parent), new ValueCommitId(cmd.merged)),
        };
    }

    // ---------------------------------------------------------------- DAG operations (write -> a CommitId)
    op_mergeCommit(cmd) {
        const c = this.db.mergeCommit(cmd.label ?? 'merge',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.merged));
        return {ok: true, commitId: String(c)};
    }

    op_enableCommit(cmd) {
        const c = this.db.enableCommit(cmd.label ?? 'enable',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.enabled));
        return {ok: true, commitId: String(c)};
    }

    op_disableCommit(cmd) {
        const c = this.db.disableCommit(cmd.label ?? 'disable',
            new ValueCommitId(cmd.parent), new ValueCommitId(cmd.disabled));
        return {ok: true, commitId: String(c)};
    }

    op_reduceHeads(cmd) {
        const c = cmd.anchor
            ? CommitDatabaseHelper.reduceHeads(this.db, new ValueCommitId(cmd.anchor))
            : CommitDatabaseHelper.reduceHeads(this.db);
        return {ok: true, commitId: c ? String(c) : null};
    }

    op_forward(cmd) {
        const c = CommitDatabaseHelper.forward(this.db, new ValueCommitId(cmd.commitId));
        return {ok: true, commitId: c ? String(c) : null};
    }

    op_fastForward(cmd) {
        const c = CommitDatabaseHelper.fastForward(this.db, new ValueCommitId(cmd.commitId));
        return {ok: true, commitId: c ? String(c) : null};
    }

    // ---------------------------------------------------------------- schema
    op_schema(cmd) {
        const dsm = DSMDefinitions.fromDefinitions(this.defs);
        if (cmd.form === 'json') return {ok: true, json: JSON.parse(dsm.toJsonString())};
        return {ok: true, dsm: dsm.toDsm()};
    }

    // ---------------------------------------------------------------- blobs (JSON plane: metadata + base64)
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
        return {ok: true, blobIds: this.db.blobIds().map(String)};
    }

    op_blobInfo(cmd) {
        const info = this.db.blobInfo(ValueBlobId.tryParse(cmd.blobId));
        return {
            ok: true, blobId: String(info.blobId()), size: info.size(),
            layout: info.blobLayout().representation(), chunked: info.chunked(), rowId: info.rowId(),
        };
    }

    op_unknownBlobIds(cmd) {
        const have = new Set(this.db.blobIds().map(String));
        return {ok: true, unknown: cmd.blobIds.filter((b) => !have.has(b))};
    }

    op_createBlob(cmd) {
        const bid = this.db.createBlob(this._layout(cmd.layout), ValueBlob.base64Decode(cmd.data));
        return {ok: true, blobId: String(bid)};
    }

    op_blob(cmd) {
        const vb = this.db.blob(ValueBlobId.tryParse(cmd.blobId));
        return {ok: true, data: vb.base64Encode(), size: vb.size()};
    }

    op_readBlob(cmd) {
        const vb = this.db.readBlob(ValueBlobId.tryParse(cmd.blobId), cmd.size, cmd.offset ?? 0);
        return {ok: true, data: vb.base64Encode()};
    }

    op_blobStreamCreate(cmd) {
        this._streamSeq += 1;
        const sid = `blob_${this._streamSeq.toString(16)}`;
        this._streams.set(sid, this.db.blobStreamCreate(this._layout(cmd.layout), cmd.size));
        return {ok: true, streamId: sid};
    }

    _stream(sid) {
        const s = this._streams.get(sid);
        if (s === undefined)
            throw new GatewayError('Gateway:Stream:Unknown', `no such blob stream ${JSON.stringify(sid)}`);
        return s;
    }

    op_blobStreamAppend(cmd) {
        const s = this._stream(cmd.streamId);
        this.db.blobStreamAppend(s, ValueBlob.base64Decode(cmd.data));
        return {ok: true, offset: s.offset(), remaining: s.remaining()};
    }

    op_blobStreamClose(cmd) {
        const s = this._stream(cmd.streamId);
        const bid = this.db.blobStreamClose(s);
        this._streams.delete(cmd.streamId);
        return {ok: true, blobId: String(bid)};
    }

    op_blobStreamDelete(cmd) {
        this._streams.delete(cmd.streamId);
        return {ok: true};
    }

    // ---------------------------------------------------------------- dispatch
    execute(cmd) {
        const op = cmd.op;
        const handler = typeof op === 'string' ? this[`op_${op}`] : undefined;
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

export class DirectoryCatalog {
    constructor(baseDir, readonly = false) {
        this.baseDir = baseDir;
        this.readonly = readonly;
    }

    // A name designates a plain file directly inside baseDir. basename() rejects
    // the separators; realpath() rejects the symlink, which passes every syntactic
    // check and still leaves the directory. Both entry points resolve here, so a
    // name that names() lists is a name open() accepts.
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

    names() {
        const out = [];
        for (const f of fs.readdirSync(this.baseDir).sort()) {
            const p = this._resolve(f);
            if (p && fs.statSync(p).isFile() && CommitDatabase.isCompatible(p)) out.push(f);
        }
        return out;
    }

    open(name) {
        const p = this._resolve(name);
        if (p === null) throw new Error(`invalid database name ${JSON.stringify(name)}`);
        if (!(fs.statSync(p).isFile() && CommitDatabase.isCompatible(p)))
            throw new Error(`no compatible database ${JSON.stringify(name)}`);
        return CommitDatabase.open(p, this.readonly);
    }
}

export class MapCatalog {
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

    open(name) {
        if (!this.mapping.has(name)) throw new Error(`no database ${JSON.stringify(name)}`);
        return CommitDatabase.open(this.mapping.get(name), this.readonly);
    }
}

// One db handle per session. Python needs a per-session lock because
// ThreadingHTTPServer serves each request on its own thread; here the event loop
// already serialises them and every binding call is synchronous, so the critical
// section is the handler itself.
export class SessionManager {
    constructor(catalog, defaultName = null, maxSessions = 1024) {
        this.catalog = catalog;
        this.default = defaultName;
        this.sessions = new Map();
        this._seq = 0;
        this._max = maxSessions;
    }

    op_databases() {
        return {ok: true, databases: this.catalog.names()};
    }

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

    op_disconnect(cmd) {
        const sess = this.sessions.get(cmd.session);
        if (sess) {
            this.sessions.delete(cmd.session);
            sess.close();
        }
        return {ok: true};
    }

    execute(cmd) {
        const op = cmd.op;
        if (op === 'databases') return this.op_databases(cmd);
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
export function serve(catalog, defaultName = null, port = 8787) {
    const mgr = new SessionManager(catalog, defaultName);

    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            let out;
            try {
                const cmd = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const token = req.headers['x-session'];
                if (token && !('session' in cmd)) cmd.session = token;
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

class SharedCatalog {
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
