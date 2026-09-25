// The basic client: the wire ops as async JavaScript. Works in Node 18+ and the browser
// (uses the global fetch), zero dependencies. The Mongo/redux sugar is the store layer (store.mjs).

/** @import {WhereNode, Mutation, WireKey} from "./mongo.mjs" */

/** A key as the server renders it. @typedef {{instance: string, concept: string | null}} HumanKey */
/**
 * One query row. The client knows no schema, so a document is `unknown` unless the caller names it.
 * @template [D=unknown]
 * @typedef {{key: HumanKey, document: D}} Row
 */
/** @typedef {string | {path: string, desc?: boolean}} OrderSpec */
/**
 * A query. `view` is a commit id, or "head" / null for the last commit.
 * @typedef {Object} Query
 * @property {string | null} [view]
 * @property {string} attachment
 * @property {WhereNode} [where]
 * @property {string[] | Record<string, string>} [select]
 * @property {Record<string, string>} [expand]
 * @property {OrderSpec[]} [orderBy]
 * @property {number} [limit]
 * @property {number} [skip]
 * @property {number} [batch]
 */
/** A command: the op and its fields. @typedef {{op: string} & Record<string, unknown>} Command */
/**
 * @typedef {Object} CommitHeader
 * @property {string} commitId
 * @property {string} parent
 * @property {number} timestamp
 * @property {string} label
 * @property {string | null} target
 */
/** @typedef {string | {dataType?: string, components?: number}} LayoutSpec */
/** @typedef {{code?: string, message?: string}} WireError */
/**
 * A successful reply. `call` resolves only on ok, and an op's reply carries the fields that op
 * names, so each field is typed as the op that sends it gives it.
 * @typedef {Object} Reply
 * @property {boolean} ok
 * @property {WireError} [error]
 * @property {string[]} databases
 * @property {string} session
 * @property {string} database
 * @property {unknown} json
 * @property {string} dsm
 * @property {unknown} value
 * @property {boolean} has
 * @property {HumanKey[]} keys
 * @property {Row[]} rows
 * @property {string} cursor
 * @property {boolean} hasMore
 * @property {HumanKey[]} added
 * @property {HumanKey[]} removed
 * @property {HumanKey[]} different
 * @property {HumanKey[]} same
 * @property {string | null} commitId
 * @property {string[]} [heads]
 * @property {string[]} commitIds
 * @property {boolean} exists
 * @property {CommitHeader} header
 * @property {boolean} isAncestor
 * @property {boolean} isMergeable
 * @property {number} count
 * @property {number} totalSize
 * @property {number} minSize
 * @property {number} maxSize
 * @property {string[]} blobIds
 * @property {string} blobId
 * @property {number} size
 * @property {string} layout
 * @property {boolean} chunked
 * @property {number} rowId
 * @property {string[]} unknown
 * @property {string} data
 * @property {string} streamId
 * @property {number} offset
 * @property {number} remaining
 */

/** A failure from the server. `code` is the structured wire contract (e.g. "Gateway:Attachment:Unknown"). */
export class GatewayError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = "GatewayError";
        this.code = code;
    }
}

export class GatewayClient {
    #url;

    /** @param {string} [baseUrl] */
    constructor(baseUrl = "http://127.0.0.1:8787") {
        this.#url = baseUrl.replace(/\/+$/, "") + "/execute";
    }

    /**
     * Send one command; resolve to the response, or throw GatewayError on `{ ok: false }`.
     * @param {Command} cmd
     * @returns {Promise<Reply>}
     */
    async call(cmd) {
        const res = await fetch(this.#url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(cmd),
        });
        const out = /** @type {Reply} */ (await res.json());
        if (!out.ok) {
            const e = out.error ?? {};
            throw new GatewayError(e.code ?? "Gateway:Unknown", e.message ?? "unknown error");
        }
        return out;
    }

    /** List the available databases (the `show dbs` equivalent). */
    async databases() {
        return (await this.call({op: "databases"})).databases;
    }

    /**
     * Open a session on a database by name (the `use` equivalent).
     * @param {string | null} [database] the server's default when omitted
     */
    async connect(database) {
        const out = await this.call({op: "connect", ...(database != null && {database})});
        return new Session(this, out.session, out.database);
    }
}

/** A session: a connection to one database. Every data op flows through here. */
export class Session {
    #client;
    #token;

    /**
     * @param {GatewayClient} client
     * @param {string} token
     * @param {string} database
     */
    constructor(client, token, database) {
        this.#client = client;
        this.#token = token;
        this.database = database;
    }

    /** @param {Command} cmd */
    #call(cmd) {
        return this.#client.call({...cmd, session: this.#token});
    }

    // ---- schema
    /** @param {"dsm" | "json"} [form] */
    async schema(form = "dsm") {
        const r = await this.#call({op: "schema", form});
        return form === "json" ? r.json : r.dsm;
    }

    // ---- read
    /**
     * @param {string | null} view
     * @param {string} attachment
     * @param {WireKey} key
     * @returns {Promise<unknown>} the document, or null
     */
    async get(view, attachment, key) {
        return (await this.#call({op: "get", view, attachment, key})).value;
    }

    /**
     * @param {string | null} view
     * @param {string} attachment
     * @param {WireKey} key
     */
    async has(view, attachment, key) {
        return (await this.#call({op: "has", view, attachment, key})).has;
    }

    /**
     * @param {string | null} view
     * @param {string} attachment
     */
    async keys(view, attachment) {
        return (await this.#call({op: "keys", view, attachment})).keys;
    }

    /** @param {Query} q */
    async query(q) {
        return (await this.#call({op: "query", ...q})).rows;
    }

    /**
     * @param {string | null} from
     * @param {string | null} to
     * @param {string} attachment
     */
    async diffKeys(from, to, attachment) {
        const {added, removed, different, same} = await this.#call({op: "diffKeys", from, to, attachment});
        return {added, removed, different, same};
    }

    /**
     * A lazy, paged read as an async-iterable: `for await (const row of db.cursor(q)) { ... }`.
     * @param {Query} q
     * @returns {AsyncGenerator<Row, void, unknown>}
     */
    async* cursor(q) {
        let r = await this.#call({op: "query", cursor: true, ...q});
        yield* r.rows;
        while (r.hasMore) {
            r = await this.#call({op: "cursorNext", cursor: r.cursor});
            yield* r.rows;
        }
    }

    /**
     * Base-pinned write -> { commitId, heads }. Divergence is signalled in `heads`, not thrown.
     * @param {string | null} base
     * @param {string} label
     * @param {Mutation[]} mutations
     */
    async commit(base, label, mutations) {
        const r = await this.#call({op: "commit", base, label, mutations});
        // a commit always answers the id it created
        return {commitId: /** @type {string} */ (r.commitId), heads: r.heads};
    }

    // ---- DAG navigation
    /** @returns {Promise<string[]>} */
    async heads() {
        // the heads op always answers them (only a commit's reply may leave `heads` out)
        return /** @type {string[]} */ ((await this.#call({op: "heads"})).heads);
    }

    async commitIds() {
        return (await this.#call({op: "commitIds"})).commitIds;
    }

    /** @param {string} commitId */
    async children(commitId) {
        return (await this.#call({op: "children", commitId})).commitIds;
    }

    /** @param {string} commitId */
    async nephews(commitId) {
        return (await this.#call({op: "nephews", commitId})).commitIds;
    }

    async firstCommitId() {
        return (await this.#call({op: "firstCommitId"})).commitId;
    }

    async lastCommitId() {
        return (await this.#call({op: "lastCommitId"})).commitId;
    }

    /** @param {string} commitId */
    async commitExists(commitId) {
        return (await this.#call({op: "commitExists", commitId})).exists;
    }

    /** @param {string} commitId */
    async commitHeader(commitId) {
        return (await this.#call({op: "commitHeader", commitId})).header;
    }

    /**
     * @param {string} commitId
     * @param {string} descendant
     */
    async isAncestor(commitId, descendant) {
        return (await this.#call({op: "isAncestor", commitId, descendant})).isAncestor;
    }

    /**
     * @param {string} parent
     * @param {string} merged
     */
    async isMergeable(parent, merged) {
        return (await this.#call({op: "isMergeable", parent, merged})).isMergeable;
    }

    // ---- DAG operations
    /**
     * @param {{label?: string, parent: string, merged: string}} args
     * @returns {Promise<string>} the commit it created
     */
    async mergeCommit({label, parent, merged}) {
        return /** @type {string} */ ((await this.#call({op: "mergeCommit", label, parent, merged})).commitId);
    }

    /**
     * @param {{label?: string, parent: string, enabled: string}} args
     * @returns {Promise<string>} the commit it created
     */
    async enableCommit({label, parent, enabled}) {
        return /** @type {string} */ ((await this.#call({op: "enableCommit", label, parent, enabled})).commitId);
    }

    /**
     * @param {{label?: string, parent: string, disabled: string}} args
     * @returns {Promise<string>} the commit it created
     */
    async disableCommit({label, parent, disabled}) {
        return /** @type {string} */ ((await this.#call({op: "disableCommit", label, parent, disabled})).commitId);
    }

    /** @param {string} [anchor] */
    async reduceHeads(anchor) {
        return (await this.#call({op: "reduceHeads", ...(anchor && {anchor})})).commitId;
    }

    /** @param {string} commitId */
    async forward(commitId) {
        return (await this.#call({op: "forward", commitId})).commitId;
    }

    /** @param {string} commitId */
    async fastForward(commitId) {
        return (await this.#call({op: "fastForward", commitId})).commitId;
    }

    // ---- blobs
    async blobStatistics() {
        const {count, totalSize, minSize, maxSize} = await this.#call({op: "blobStatistics"});
        return {count, totalSize, minSize, maxSize};
    }

    async blobIds() {
        return (await this.#call({op: "blobIds"})).blobIds;
    }

    /** @param {string} blobId */
    async blobInfo(blobId) {
        const {size, layout, chunked, rowId} = await this.#call({op: "blobInfo", blobId});
        return {blobId, size, layout, chunked, rowId};
    }

    /** @param {string[]} blobIds */
    async unknownBlobIds(blobIds) {
        return (await this.#call({op: "unknownBlobIds", blobIds})).unknown;
    }

    /**
     * @param {LayoutSpec} layout
     * @param {string} data base64
     */
    async createBlob(layout, data) {
        return (await this.#call({op: "createBlob", layout, data})).blobId;
    }

    /** @param {string} blobId */
    async blob(blobId) {
        const {data, size} = await this.#call({op: "blob", blobId});
        return {data, size};
    }

    /**
     * @param {string} blobId
     * @param {number} size
     * @param {number} [offset]
     */
    async readBlob(blobId, size, offset = 0) {
        return (await this.#call({op: "readBlob", blobId, size, offset})).data;
    }

    /**
     * @param {LayoutSpec} layout
     * @param {number} size
     */
    async blobStreamCreate(layout, size) {
        return (await this.#call({op: "blobStreamCreate", layout, size})).streamId;
    }

    /**
     * @param {string} streamId
     * @param {string} data base64
     */
    async blobStreamAppend(streamId, data) {
        const {offset, remaining} = await this.#call({op: "blobStreamAppend", streamId, data});
        return {offset, remaining};
    }

    /** @param {string} streamId */
    async blobStreamClose(streamId) {
        return (await this.#call({op: "blobStreamClose", streamId})).blobId;
    }

    /** @param {string} streamId */
    async blobStreamDelete(streamId) {
        await this.#call({op: "blobStreamDelete", streamId});
    }

    // ---- lifecycle
    async disconnect() {
        await this.#call({op: "disconnect"});
    }
}
