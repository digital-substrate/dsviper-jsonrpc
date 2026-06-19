# JavaScript SDK

Drive a Viper `CommitDatabase` from JavaScript over the JSON wire. **ESM, zero dependencies**, runs
in Node 18+ and the browser (it uses the global `fetch`). Three modules, two levels of use:

| Module | Role | What it is |
|--------|------|------------|
| `client.mjs` | basic client | the wire ops as async methods, 1:1 with the server (`GatewayClient` → `Session`) |
| `store.mjs`  | application model | the redux-style `CommitStore` over the basic client: head + undo stack, `dispatch`, `subscribe`, `collection()` |
| `mongo.mjs`  | dialect | a Mongo filter/update → the neutral wire (`toWhere` / `toMutations`); used by the store |

There is no package to install — the modules are dependency-free `.mjs` files. Vendor them and import
by relative path (the import path depth depends on where you copy them):

```js
import { GatewayClient, GatewayError } from "./clients/js/client.mjs";
import { CommitStore, actions } from "./clients/js/store.mjs";
```

The full wire contract these speak is **[../../ARCHITECTURE.md](../../ARCHITECTURE.md)**; runnable
end-to-end examples live in **[../../tests/clients/js](../../tests/clients/js)** and
**[../../demos/js](../../demos/js)**.

## Basic client

The 1:1 dual of the wire. A `GatewayClient` lists databases and opens a `Session`; every data op
flows through the session (which carries the token for you).

```js
const client = new GatewayClient("http://127.0.0.1:8787");
await client.databases();                       // ["scene.graph", …]   (the `show dbs` equivalent)
const db = await client.connect("scene.graph"); // → Session            (the `use` equivalent)

// read — pinned by an explicit view (a commit id); there is no server-side "current"
const head = (await db.heads())[0];
const verts = await db.query({ view: head, attachment: "Graph::Vertex.visualAttributes",
                              where: { op: "gte", path: "value", value: 2 } });
const one  = await db.get(head, "Graph::Vertex.visualAttributes",
                          { instance: "…", concept: "Graph::Vertex" });

// lazy paging — an async iterator
for await (const row of db.cursor({ view: head, attachment: "Graph::Vertex.visualAttributes" })) {
  // …
}

// write — base-pinned, one envelope = one atomic commit → { commitId, heads }
const { commitId, heads } = await db.commit(head, "edit", [
  { set: { attachment: "Graph::Vertex.visualAttributes",
           key: { instance: "…", concept: "Graph::Vertex" }, value: { value: 7 } } },
]);
if (heads.length > 1) { /* a concurrent writer diverged — reconcile explicitly (see below) */ }

await db.disconnect();
```

`Session` also exposes the commit DAG verbatim — `commitIds`, `children` / `nephews`,
`first/lastCommitId`, `commitExists` / `commitHeader`, `isAncestor` / `isMergeable`, and the ops
`mergeCommit`, `enable/disableCommit`, `reduceHeads`, `forward` / `fastForward` — plus the blob plane
(`createBlob`, `blob`, `readBlob`, the `blobStream*` upload, `unknownBlobIds`, …). See the method
list in `client.mjs` and the op tables in ARCHITECTURE.md §3.

**Errors.** A `{ ok: false }` response throws a `GatewayError`; the structured `code` is the
contract, the message is informative:

```js
try { await db.get(head, "Nope.nope", key); }
catch (e) { if (e instanceof GatewayError) console.error(e.code); } // "Gateway:Attachment:Unknown"
```

## CommitStore

The redux-style application model — *redux where the reducer is the commit*: persistent, versioned,
asynchronous, with non-destructive undo. It holds the current head client-side; every transition is a
wire round-trip. This is the over-the-wire dual of the in-process C++ `dsviper.CommitStore`.

```js
const store = await CommitStore.open(client, "scene.graph");

store.subscribe((s) => render(s));   // s = { database, head, diverged, canUndo, canRedo }

// reads + writes through a Mongo-style collection facade over one attachment
const vertices = store.collection("Graph::Vertex.visualAttributes");
await vertices.find({ value: { $gte: 2 } }, { orderBy: ["value"], limit: 10 });
await vertices.updateOne(key, { $set: { value: 7 } });        // → one commit, head advances, notifies

// or dispatch the verbs directly (one action, or a batch, sealed as ONE commit)
await store.dispatch(actions.set("Graph::Vertex.visualAttributes", key, { value: 7 }));

// undo / redo — non-destructive (an enable/disable commit on the DAG), bounded by the stack
await store.undo();
await store.redo();

// divergence is detected, never auto-merged — reconcile explicitly
if (store.getState().diverged) await store.reduceHeads();      // or store.mergeCommit(otherHead)

await store.close();
```

The Mongo dialect (`mongo.mjs`) currently maps `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists` and the
combinators `$and/$or/$nor/$not` for reads, and `$set/$addToSet/$pull` for writes; `_id` addresses
the instance. It is pure JSON reshaping — add operators there without touching the server.
