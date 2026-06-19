// The basic client: the wire ops as async JavaScript. Works in Node 18+ and the browser
// (uses the global fetch), zero dependencies. The Mongo/redux sugar is the store layer (store.mjs).

/** A failure from the server. `code` is the structured wire contract (e.g. "Gateway:Attachment:Unknown"). */
export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export class GatewayClient {
  #url;

  constructor(baseUrl = "http://127.0.0.1:8787") {
    this.#url = baseUrl.replace(/\/+$/, "") + "/execute";
  }

  /** Send one command; resolve to the response, or throw GatewayError on `{ ok: false }`. */
  async call(cmd) {
    const res = await fetch(this.#url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const out = await res.json();
    if (!out.ok) {
      const e = out.error ?? {};
      throw new GatewayError(e.code ?? "Gateway:Unknown", e.message ?? "unknown error");
    }
    return out;
  }

  /** List the available databases (the `show dbs` equivalent). */
  async databases() {
    return (await this.call({ op: "databases" })).databases;
  }

  /** Open a session on a database by name (the `use` equivalent). */
  async connect(database) {
    const out = await this.call({ op: "connect", ...(database != null && { database }) });
    return new Session(this, out.session, out.database);
  }
}

/** A session: a connection to one database. Every data op flows through here. */
export class Session {
  #client;
  #token;

  constructor(client, token, database) {
    this.#client = client;
    this.#token = token;
    this.database = database;
  }

  #call(cmd) {
    return this.#client.call({ ...cmd, session: this.#token });
  }

  // ---- schema
  async schema(form = "dsm") {
    const r = await this.#call({ op: "schema", form });
    return form === "json" ? r.json : r.dsm;
  }

  // ---- read
  async get(view, attachment, key) {
    return (await this.#call({ op: "get", view, attachment, key })).value;
  }
  async has(view, attachment, key) {
    return (await this.#call({ op: "has", view, attachment, key })).has;
  }
  async keys(view, attachment) {
    return (await this.#call({ op: "keys", view, attachment })).keys;
  }
  async query(q) {
    return (await this.#call({ op: "query", ...q })).rows;
  }
  async diffKeys(from, to, attachment) {
    const { added, removed, different, same } = await this.#call({ op: "diffKeys", from, to, attachment });
    return { added, removed, different, same };
  }

  /** A lazy, paged read as an async-iterable: `for await (const row of db.cursor(q)) { ... }`. */
  async *cursor(q) {
    let r = await this.#call({ op: "query", cursor: true, ...q });
    yield* r.rows;
    while (r.hasMore) {
      r = await this.#call({ op: "cursorNext", cursor: r.cursor });
      yield* r.rows;
    }
  }

  /** Base-pinned write -> { commitId, heads }. Divergence is signalled in `heads`, not thrown. */
  async commit(base, label, mutations) {
    const r = await this.#call({ op: "commit", base, label, mutations });
    return { commitId: r.commitId, heads: r.heads };
  }

  // ---- DAG navigation
  async heads() { return (await this.#call({ op: "heads" })).heads; }
  async commitIds() { return (await this.#call({ op: "commitIds" })).commitIds; }
  async children(commitId) { return (await this.#call({ op: "children", commitId })).commitIds; }
  async nephews(commitId) { return (await this.#call({ op: "nephews", commitId })).commitIds; }
  async firstCommitId() { return (await this.#call({ op: "firstCommitId" })).commitId; }
  async lastCommitId() { return (await this.#call({ op: "lastCommitId" })).commitId; }
  async commitExists(commitId) { return (await this.#call({ op: "commitExists", commitId })).exists; }
  async commitHeader(commitId) { return (await this.#call({ op: "commitHeader", commitId })).header; }
  async isAncestor(commitId, descendant) { return (await this.#call({ op: "isAncestor", commitId, descendant })).isAncestor; }
  async isMergeable(parent, merged) { return (await this.#call({ op: "isMergeable", parent, merged })).isMergeable; }

  // ---- DAG operations
  async mergeCommit({ label, parent, merged }) { return (await this.#call({ op: "mergeCommit", label, parent, merged })).commitId; }
  async enableCommit({ label, parent, enabled }) { return (await this.#call({ op: "enableCommit", label, parent, enabled })).commitId; }
  async disableCommit({ label, parent, disabled }) { return (await this.#call({ op: "disableCommit", label, parent, disabled })).commitId; }
  async reduceHeads(anchor) { return (await this.#call({ op: "reduceHeads", ...(anchor && { anchor }) })).commitId; }
  async forward(commitId) { return (await this.#call({ op: "forward", commitId })).commitId; }
  async fastForward(commitId) { return (await this.#call({ op: "fastForward", commitId })).commitId; }

  // ---- blobs
  async blobStatistics() {
    const { count, totalSize, minSize, maxSize } = await this.#call({ op: "blobStatistics" });
    return { count, totalSize, minSize, maxSize };
  }
  async blobIds() { return (await this.#call({ op: "blobIds" })).blobIds; }
  async blobInfo(blobId) {
    const { size, layout, chunked, rowId } = await this.#call({ op: "blobInfo", blobId });
    return { blobId, size, layout, chunked, rowId };
  }
  async unknownBlobIds(blobIds) { return (await this.#call({ op: "unknownBlobIds", blobIds })).unknown; }
  async createBlob(layout, data) { return (await this.#call({ op: "createBlob", layout, data })).blobId; }
  async blob(blobId) {
    const { data, size } = await this.#call({ op: "blob", blobId });
    return { data, size };
  }
  async readBlob(blobId, size, offset = 0) { return (await this.#call({ op: "readBlob", blobId, size, offset })).data; }
  async blobStreamCreate(layout, size) { return (await this.#call({ op: "blobStreamCreate", layout, size })).streamId; }
  async blobStreamAppend(streamId, data) {
    const { offset, remaining } = await this.#call({ op: "blobStreamAppend", streamId, data });
    return { offset, remaining };
  }
  async blobStreamClose(streamId) { return (await this.#call({ op: "blobStreamClose", streamId })).blobId; }
  async blobStreamDelete(streamId) { await this.#call({ op: "blobStreamDelete", streamId }); }

  // ---- lifecycle
  async disconnect() { await this.#call({ op: "disconnect" }); }
}
