// The CommitStore: a redux-style store over the basic client, whose reducer is the commit
// (persistent, versioned, asynchronous, with non-destructive undo). Mongo `find` reads, redux
// `dispatch` writes -- both client-side over the neutral wire. The over-the-wire dual of the C++
// dsviper.CommitStore.
import {toWhere, toMutations} from "./mongo.mjs";

/** @import {GatewayClient, Session, Query} from "./client.mjs" */
/** @import {MongoFilter, MongoUpdate, Mutation, WireKey} from "./mongo.mjs" */

/**
 * @typedef {Object} StoreState
 * @property {string} database
 * @property {string} head
 * @property {boolean} diverged
 * @property {boolean} canUndo
 * @property {boolean} canRedo
 */
/** @typedef {(state: StoreState) => void} Listener */
/** @typedef {Pick<Query, "select" | "expand" | "orderBy" | "limit" | "skip">} FindOptions */

/** Action creators -- one per mutation verb. An action IS a wire mutation; dispatch seals them in a commit. */
/** @typedef {(attachment: string, key: WireKey, path: string, value: unknown) => Mutation} PathAction */
export const actions = {
    /** @type {(attachment: string, key: WireKey, value: unknown) => Mutation} */
    set: (attachment, key, value) => ({set: {attachment, key, value}}),
    /** @type {(attachment: string, key: WireKey, value: unknown, recursive?: boolean | null) => Mutation} */
    diff: (attachment, key, value, recursive) => ({
        diff: {
            attachment,
            key,
            value, ...(recursive != null && {recursive})
        }
    }),
    /** @type {PathAction} */
    update: (attachment, key, path, value) => ({update: {attachment, key, path, value}}),
    /** @type {PathAction} */
    unionInSet: (attachment, key, path, value) => ({union_in_set: {attachment, key, path, value}}),
    /** @type {PathAction} */
    subtractInSet: (attachment, key, path, value) => ({subtract_in_set: {attachment, key, path, value}}),
    /** @type {PathAction} */
    unionInMap: (attachment, key, path, value) => ({union_in_map: {attachment, key, path, value}}),
    /** @type {PathAction} */
    subtractInMap: (attachment, key, path, value) => ({subtract_in_map: {attachment, key, path, value}}),
    /** @type {PathAction} */
    updateInMap: (attachment, key, path, value) => ({update_in_map: {attachment, key, path, value}}),
};

/** A faithful port of the C++ Viper::CommitUndoStack: a list of (commitId, disableCommitId?) with a
 *  cursor (index 0 is the reset sentinel). undo/redo move the cursor; the disable-commit ids let
 *  undo/redo toggle a change by enabling/disabling the disable-commit it first created. */
class CommitUndoStack {
    /** @type {{commitId: string | null, disableCommitId: string | null}[]} */
    #entries;
    /** @type {number} */
    #index;

    constructor() {
        this.reset(null);
    }

    /** @param {string | null} initialCommitId */
    reset(initialCommitId) {
        this.#entries = [{commitId: initialCommitId, disableCommitId: null}];
        this.#index = 0;
    }

    get canUndo() {
        return this.#index !== 0;
    }

    get canRedo() {
        return this.#index < this.#entries.length - 1;
    }

    undo() {
        this.#index -= 1;
    }

    redo() {
        this.#index += 1;
    }

    get currentCommitId() {
        return this.#entries[this.#index].commitId;
    }

    get currentDisableCommitId() {
        return this.#entries[this.#index].disableCommitId;
    }

    /** @param {string} commitId */
    set(commitId) {
        if (this.#index !== this.#entries.length - 1) this.#entries.length = this.#index + 1;
        this.#entries.push({commitId, disableCommitId: null});
        this.#index = this.#entries.length - 1;
    }

    /** @param {string} commitId */
    setDisableCommitId(commitId) {
        this.#entries[this.#index].disableCommitId = commitId;
    }
}

export class CommitStore {
    /** @type {Session} */
    #session;
    /** @type {string} */
    #head;
    /** @type {Set<Listener>} */
    #listeners = new Set();
    #undoStack = new CommitUndoStack();
    #diverged = false;

    /**
     * @param {GatewayClient} client
     * @param {string} [database]
     */
    static async open(client, database) {
        const session = await client.connect(database);
        // the store holds a head: it opens a database that has one
        const head = /** @type {string} */ ((await session.heads())[0] ?? (await session.lastCommitId()));
        return new CommitStore(session, head);
    }

    /**
     * @param {Session} session
     * @param {string} head
     */
    constructor(session, head) {
        this.#session = session;
        this.#head = head;
        this.#undoStack.reset(head);
    }

    /** The state is the head pointer + flags -- not a local mirror of every document (the db is the state). */
    /** @returns {StoreState} */
    getState() {
        return {
            database: this.#session.database,
            head: this.#head,
            diverged: this.#diverged,
            canUndo: this.#undoStack.canUndo,
            canRedo: this.#undoStack.canRedo,
        };
    }

    /** redux subscribe: returns an unsubscribe function. */
    /** @param {Listener} listener */
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #notify() {
        const s = this.getState();
        for (const l of this.#listeners) l(s);
    }

    /** A collection facade over one attachment, at the held head (Mongo read + write). */
    /** @param {string} attachment */
    collection(attachment) {
        const store = this;
        return {
            /**
             * @param {MongoFilter} [filter]
             * @param {FindOptions} [options]
             */
            find(filter, {select, expand, orderBy, limit, skip} = {}) {
                return store.#session.query({
                    view: store.#head, attachment, where: toWhere(filter), select, expand, orderBy, limit, skip,
                });
            },
            /** @param {WireKey} key */
            findOne(key) {
                return store.#session.get(store.#head, attachment, key);
            },
            keys() {
                return store.#session.keys(store.#head, attachment);
            },
            /**
             * @param {WireKey} key
             * @param {MongoUpdate} update
             * @param {string} [label]
             */
            updateOne(key, update, label = "update") {
                return store.dispatch(toMutations(attachment, key, update), label);
            },
            /**
             * @param {WireKey} key
             * @param {unknown} document
             * @param {string} [label]
             */
            insertOne(key, document, label = "insert") {
                return store.dispatch([{set: {attachment, key, value: document}}], label);
            },
        };
    }

    /** Apply one action (or a batch) as ONE commit on the held head; advance the head; notify. */
    /**
     * @param {Mutation | Mutation[]} action
     * @param {string} [label]
     */
    async dispatch(action, label = "dispatch") {
        const mutations = Array.isArray(action) ? action : [action];
        const {commitId, heads} = await this.#session.commit(this.#head, label, mutations);
        this.#head = commitId;
        this.#undoStack.set(commitId);
        this.#diverged = (heads?.length ?? 1) > 1;
        this.#notify();
        return commitId;
    }

    // ---- undo / redo
    async undo() {
        if (!this.#undoStack.canUndo) return;
        // past the reset sentinel, every entry holds the commit it recorded
        const current = /** @type {string} */ (this.#undoStack.currentCommitId);
        const disableId = this.#undoStack.currentDisableCommitId;
        const label = `Undo [${(await this.#session.commitHeader(current)).label}]`;
        if (disableId != null) {
            this.#head = await this.#session.enableCommit({label, parent: this.#head, enabled: disableId});
        } else {
            this.#head = await this.#session.disableCommit({label, parent: this.#head, disabled: current});
            this.#undoStack.setDisableCommitId(this.#head);
        }
        this.#undoStack.undo();
        this.#notify();
    }

    async redo() {
        if (!this.#undoStack.canRedo) return;
        this.#undoStack.redo();
        const current = /** @type {string} */ (this.#undoStack.currentCommitId);
        // a redoable entry was undone, which recorded (or re-enabled) its disable-commit
        const disableId = /** @type {string} */ (this.#undoStack.currentDisableCommitId);
        const label = `Redo [${(await this.#session.commitHeader(current)).label}]`;
        this.#head = await this.#session.disableCommit({label, parent: this.#head, disabled: disableId});
        this.#notify();
    }

    // ---- divergence
    async reduceHeads() {
        const head = await this.#session.reduceHeads();
        if (head) {
            this.#head = head;
            this.#diverged = false;
            this.#notify();
        }
        return head;
    }

    /**
     * @param {string} other
     * @param {string} [label]
     */
    async mergeCommit(other, label = "merge") {
        this.#head = await this.#session.mergeCommit({label, parent: this.#head, merged: other});
        this.#diverged = (await this.#session.heads()).length > 1;
        this.#notify();
        return this.#head;
    }

    /** Re-read the head from the server (e.g. after an external change). */
    async refresh() {
        const heads = await this.#session.heads();
        this.#diverged = heads.length > 1;
        if (!heads.includes(this.#head)) this.#head = heads[0];
        this.#notify();
    }

    async close() {
        await this.#session.disconnect();
    }
}
