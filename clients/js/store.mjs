// The CommitStore: a redux-style store over the basic client, whose reducer is the commit
// (persistent, versioned, asynchronous, with non-destructive undo). Mongo `find` reads, redux
// `dispatch` writes -- both client-side over the neutral wire. The over-the-wire dual of the C++
// dsviper.CommitStore.
import {toWhere, toMutations} from "./mongo.mjs";

/** Action creators -- one per mutation verb. An action IS a wire mutation; dispatch seals them in a commit. */
export const actions = {
    set: (attachment, key, value) => ({set: {attachment, key, value}}),
    diff: (attachment, key, value, recursive) => ({
        diff: {
            attachment,
            key,
            value, ...(recursive != null && {recursive})
        }
    }),
    update: (attachment, key, path, value) => ({update: {attachment, key, path, value}}),
    unionInSet: (attachment, key, path, value) => ({union_in_set: {attachment, key, path, value}}),
    subtractInSet: (attachment, key, path, value) => ({subtract_in_set: {attachment, key, path, value}}),
    unionInMap: (attachment, key, path, value) => ({union_in_map: {attachment, key, path, value}}),
    subtractInMap: (attachment, key, path, value) => ({subtract_in_map: {attachment, key, path, value}}),
    updateInMap: (attachment, key, path, value) => ({update_in_map: {attachment, key, path, value}}),
};

/** A faithful port of the C++ Viper::CommitUndoStack: a list of (commitId, disableCommitId?) with a
 *  cursor (index 0 is the reset sentinel). undo/redo move the cursor; the disable-commit ids let
 *  undo/redo toggle a change by enabling/disabling the disable-commit it first created. */
class CommitUndoStack {
    #entries;
    #index;

    constructor() {
        this.reset(null);
    }

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

    set(commitId) {
        if (this.#index !== this.#entries.length - 1) this.#entries.length = this.#index + 1;
        this.#entries.push({commitId, disableCommitId: null});
        this.#index = this.#entries.length - 1;
    }

    setDisableCommitId(commitId) {
        this.#entries[this.#index].disableCommitId = commitId;
    }
}

export class CommitStore {
    #session;
    #head;
    #listeners = new Set();
    #undoStack = new CommitUndoStack();
    #diverged = false;

    static async open(client, database) {
        const session = await client.connect(database);
        const head = (await session.heads())[0] ?? (await session.lastCommitId());
        return new CommitStore(session, head);
    }

    constructor(session, head) {
        this.#session = session;
        this.#head = head;
        this.#undoStack.reset(head);
    }

    /** The state is the head pointer + flags -- not a local mirror of every document (the db is the state). */
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
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #notify() {
        const s = this.getState();
        for (const l of this.#listeners) l(s);
    }

    /** A collection facade over one attachment, at the held head (Mongo read + write). */
    collection(attachment) {
        const store = this;
        return {
            find(filter, {select, expand, orderBy, limit, skip} = {}) {
                return store.#session.query({
                    view: store.#head, attachment, where: toWhere(filter), select, expand, orderBy, limit, skip,
                });
            },
            findOne(key) {
                return store.#session.get(store.#head, attachment, key);
            },
            keys() {
                return store.#session.keys(store.#head, attachment);
            },
            updateOne(key, update, label = "update") {
                return store.dispatch(toMutations(attachment, key, update), label);
            },
            insertOne(key, document, label = "insert") {
                return store.dispatch([{set: {attachment, key, value: document}}], label);
            },
        };
    }

    /** Apply one action (or a batch) as ONE commit on the held head; advance the head; notify. */
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
        const current = this.#undoStack.currentCommitId;
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
        const current = this.#undoStack.currentCommitId;
        const disableId = this.#undoStack.currentDisableCommitId;
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
