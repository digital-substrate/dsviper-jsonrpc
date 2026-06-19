# Architecture & wire contract

This document is the design reference and the normative wire contract for driving a Viper
`CommitDatabase` from any language over JSON. `README.md` describes the proof-of-concept and how
to run it; **this** document describes the layered architecture and the contract that the gateway
and the clients implement. It is self-contained: everything needed to implement a gateway or a
client is here.

> **One law.** `JSON = Viper − the type.` Structure and data cross the wire as literals; the
> *type* is supplied on arrival from the schema. The gateway elaborates literals into typed
> runtime terms and renders typed terms back into literals.

## 1. The layered stack

```
0  RUNTIME    CommitDatabase / CommitState / CommitMutableState   (the dsviper wheel)
              The DAG of immutable, content-addressed commits. Gives CONVERGENCE.
              Holds no model of collaboration — that is delegated upward, by design.

1  GATEWAY    A faithful 1:1 JSON projection of the CommitDatabase interface.
              Thin, mostly stateless. Resolves literals ⇄ runtime terms, runs the ops,
              renders results. Exposes the primitives verbatim; never reconciles for you.

2a CLIENT     The basic client — the wire ops expressed as async calls in the host
              language (Promises in JavaScript). Persona-neutral. The dual of the wire.

2b CLIENT     The store — an application model built on 2a. A redux-style store: it holds
              the current head and an undo stack, dispatches mutations, and exposes a
              familiar query surface. This is where the pieces assemble for an app developer.
```

**Two personas, by surface:**

| Surface | Persona | Why |
|---------|---------|-----|
| **read / query** | **document store** (`find`, operators, projection, sort, cursor) | matches a backend developer's expectation; values *do* read like a collection |
| **state / mutation** | **redux + git** (`dispatch` / `undo` over a commit DAG: heads, merge, reconcile) | a write returns a commit id, not an in-place mutation; history is the substrate |

The familiarity lives in the **client** (2a/2b). The **wire stays persona-neutral** — a client
translates its dialect onto the neutral wire, so the wire never couples to one vocabulary.

## 2. Wire conventions

Every call is one JSON request → one JSON response.

```jsonc
// request
{ "op": "<name>", ... }
// success
{ "ok": true, ... }
// failure — the structured code is the contract, not the message
{ "ok": false, "error": { "code": "Component:Domain:Code", "message": "…" } }
```

Identifiers are opaque strings: a **commit id** and a **blob id** are hex; an **instance id** is a
UUID. **Attachments** travel as their canonical identifier `<qualified keyType>.<name>` (e.g.
`"Graph::Vertex.visualAttributes"`). **Concepts** travel as qualified human names
(`NameSpace::Concept`); runtime ids never cross the wire.

The gateway is the runtime dual of a generated static bridge: what a code generator projects
*statically* per attachment (typed accessors that resolve the attachment, encode typed↔value, call
the dynamic interface), the gateway does *generically* — resolve the attachment by identifier,
encode/decode JSON instead of generated codecs, call the same dynamic interface.

## 3. The contract — three columns

Runtime interface ↔ wire op ↔ basic client method. Verified against the binding (the type stub is
not authoritative).

### 3.1 Schema

| Runtime | Wire | Client |
|---------|------|--------|
| `definitions()` → DSM text / DSM-JSON | `{op:"schema", form:"dsm"\|"json", attachments?}` | `client.schema(form)` |

### 3.2 Read / query — resolved over an immutable `CommitState` pinned by `view`

| Runtime | Wire | Client |
|---------|------|--------|
| `AttachmentGetting.get/has/keys` | `{op:"get"\|"has"\|"keys", view, attachment, key?}` | `client.get/has/keys(...)` |
| the query engine (§4) | `{op:"query", view, attachment, where?, select?, expand?, orderBy?, skip?, limit?}` | `client.query(q)` |
| lazy paging | `{op:"query", …, cursor:true, batch}` then `{op:"cursorNext", cursor}` / `{op:"cursorClose", cursor}` | `client.query(...)` → **async iterator** |
| `AttachmentGetting.diff_keys` | `{op:"diffKeys", from, to, attachment}` → `{added, removed, different, same}` | `client.diffKeys(...)` |

### 3.3 Write — the eleven-verb envelope, base-pinned, one envelope = one atomic commit

```jsonc
{ "op": "commit", "base": "<commitId>", "label": "edit",
  "mutations": [ { "<verb>": { "attachment": "…", "key": {…}, ... } }, … ] }
→ { "ok": true, "commitId": "<newId>" }
```

The gateway builds a `CommitMutableState` from `base`, replays the verbs onto its
`AttachmentMutating`, and seals with `commit_mutations(label, ms)`.

| Verb | Fields (besides `attachment`, `key`) | Meaning |
|------|--------------------------------------|---------|
| `set` | `value` | replace the whole document |
| `diff` | `value`, `recursive` | diff-merge `value` into the document |
| `update` | `path`, `value` | set `value` at `path` |
| `union_in_set` | `path`, `value` (array) | add elements to a set |
| `subtract_in_set` | `path`, `value` (array) | remove elements from a set |
| `union_in_map` | `path`, `value` (object) | merge entries into a map |
| `subtract_in_map` | `path`, `value` (array of **keys**) | remove keys from a map |
| `update_in_map` | `path`, `value` (object) | update entries in a map |
| `insert_in_xarray` | `path`, `beforePosition`, `newPosition`, `value` | insert at an ordered position |
| `update_in_xarray` | `path`, `position`, `value` | update the element at `position` |
| `remove_in_xarray` | `path`, `position` | remove the element at `position` |

> Note the asymmetry, verbatim from the runtime: `union_in_map`/`update_in_map` carry a **map**
> (object), but `subtract_in_map` carries a **set of keys** (array).

### 3.4 The commit DAG — navigation reads; ops yield a new commit id

| Runtime | Wire | Client |
|---------|------|--------|
| `head_commit_ids()` | `{op:"heads"}` | `client.heads()` |
| `commit_ids()` | `{op:"commitIds"}` | `client.commitIds()` |
| `children_commit_ids(id)` / `nephew_commit_ids(id)` | `{op:"children"\|"nephews", commitId}` | `client.children/nephews(id)` |
| `first_commit_id()` / `last_commit_id()` | `{op:"firstCommitId"\|"lastCommitId"}` | `client.firstCommitId/lastCommitId()` |
| `commit_exists(id)` / `commit_header(id)` | `{op:"commitExists"\|"commitHeader", commitId}` | `client.commitExists/commitHeader(id)` |
| `is_ancestor(id, descendant)` / `is_mergeable(parent, merged)` | `{op:"isAncestor"\|"isMergeable", …}` | `client.isAncestor/isMergeable(...)` |
| `merge_commit(label, parent, merged)` | `{op:"mergeCommit", label, parent, merged}` | `client.mergeCommit(...)` |
| `enable_commit` / `disable_commit(label, parent, target)` | `{op:"enableCommit"\|"disableCommit", label, parent, …}` | `client.enable/disableCommit(...)` |
| `reduce_heads(db, commitId?)` | `{op:"reduceHeads", anchor?}` | `client.reduceHeads(anchor?)` |
| `forward(db, id)` / `fast_forward(db, id)` | `{op:"forward"\|"fastForward", commitId}` | `client.forward/fastForward(id)` |
| `delete_commit` / `reset_commits` | **not exposed** — destructive history rewrites have no place on the wire | — |

### 3.5 Blobs — two planes bridged by a blob id

A blob is a content-addressed, typed binary array — a `BlobLayout` (`<dataType>-<components>`, e.g.
`uchar-4` for RGBA) plus the bytes — addressed by its `blobId` (the content hash, so identical bytes
dedup to one id). A document carries only the `blobId`; the bytes move on their own ops.

**JSON plane (implemented).** Metadata and base64 transfer, all over `/execute`:

| Op | Meaning |
|----|---------|
| `blobStatistics` | `{count, totalSize, minSize, maxSize}` |
| `blobIds` / `blobInfo {blobId}` / `blobInfos {blobIds}` | the ids / `{size, layout, chunked, rowId}` |
| `unknownBlobIds {blobIds}` | the subset not present (have/want sync, dedup-aware) |
| `createBlob {layout, data}` | base64 `data` → `{blobId}` (content-addressed) |
| `blob {blobId}` / `readBlob {blobId, size, offset}` | base64 out — whole / by range |
| `blobStreamCreate {layout, size}` → `{streamId}`; `blobStreamAppend {streamId, data}` (sequential) → `{offset, remaining}`; `blobStreamClose {streamId}` → `{blobId}`; `blobStreamDelete` | a resumable, content-addressed upload; the stream is session state |

**Binary plane (a transport optimisation, deferred).** For large assets, raw-bytes HTTP routes avoid
base64 overhead: `GET /blob/{id}` (+ `Range` → `readBlob`) and `PUT /blobStream/{id}`. Same semantics
as the JSON ops, just off the JSON plane.

**Referential integrity — upload before you reference.** A document may reference only a `blobId`
**already present in the store**: a commit whose mutations reference a missing blob is rejected by the
runtime (`Missing blob …`, surfaced on the wire as a structured commit error). So the order is fixed —
**store the bytes first** (`createBlob` / the blob stream), get the `blobId`, **then** commit the
document that carries it. `unknownBlobIds` is the sync primitive for this: send the ids you intend to
reference, learn which are missing, upload only those, then commit. (Blobs live at the database level,
alongside the commit DAG but distinct from it — storing a blob is not itself a commit.)

### 3.6 Sessions

`connect` / `hello` opens a session and returns a token; ops carry the token (in the body or an
`X-Session` header). Every data op requires a session — **connect first**.

**One `CommitDatabase` handle per session.** `connect` opens its own handle (its own SQLite
connection — a connection is not shared across sessions or threads), so a session's ops are
serialised by a per-session lock and distinct sessions proceed independently. Sessions opening the
**same** database file share data through the DAG (each sees the others' commits). A session also
holds its open **cursors** and **blob streams** (the only other server-held state — bounded by idle
timeout and a per-session cap); `disconnect` closes the handle and releases them.

**Database selection — a catalog, by name.** The server holds a catalog (typically the
`CommitDatabase` files in a directory); `databases` lists it and `connect` opens one by **name**
(the `show dbs` / `use` pair). A database is any file the runtime accepts as a `CommitDatabase`
(`is_compatible` — the SQL schema has the required tables); the **extension is irrelevant** (the
DSM is embedded). Clients pass a **name, never a filesystem path**, and the name is validated to a
direct child (no traversal); an unknown name → `Gateway:Database:Unknown`.

```json
{ "op": "databases" }                    → { "ok": true, "databases": ["scene.graph", "myapp.rapmc"] }
{ "op": "connect", "database": "scene.graph" } → { "ok": true, "session": "s1", "database": "scene.graph" }
```

There is **no server-side head**: the read `view` and the write `base` are concrete commit ids the
client supplies on every call (the client's store holds "my head").

## 4. The query language

A query is compiled, server-side, into a lazy chain over the pinned `CommitState`. The read is an
**intrinsic scan** (a `CommitDatabase` is a DAG folded into a snapshot, not an indexable table); the
optimization surface is laziness — short-circuit terminals (`limit` stops early) and **key-pushdown**
(a key-only predicate is tested before the document is materialized, so rejected keys cost zero
fetches).

### 4.1 `where` — a tagged tree (the wire form)

The wire predicate is a **tagged tree**: every node carries an explicit `op`, so the server is a
pure recursive descent — no field-vs-operator ambiguity, no reserved-word hazard.

```jsonc
{ "op": "and", "args": [
    { "op": "gte", "path": "value", "value": 2 },
    { "op": "in",  "key":  "instance", "value": ["…"] } ] }
```

- **comparators** (leaves): `eq ne gt gte lt lte in nin exists`.
- **combinators** (nodes): `and` / `or` (with `args`), `not` (with `arg`).
- a leaf addresses **either** `path` (a path into the rendered document) **or** `key`
  (`"instance"` / `"concept"`). A `key`-only conjunct is pushed below the document fetch.

### 4.2 `select`, `expand`, `orderBy`, window

- `select`: `["value", "color.red"]` (an include-list, nesting preserved) **or**
  `{ "v": "value", "r": "color.red" }` (aliased, flat). The key always travels in the row envelope.
- `expand`: `{ "vaKey": "Graph::Vertex.render2DAttributes" }` — follow a key-valued field to a target
  attachment. This is a **pointer follow**, not a match: a key already addresses `(instance, concept)`,
  so the target document is fetched directly. `from` is the target attachment identifier (it also
  selects *which facet* of the referenced entity to dereference); there is no foreign-field to match.
- `orderBy`: `["value", {"path":"name","desc":true}]`. `skip` / `limit` window the result.

### 4.3 The client dialect (document-store flavor)

The familiar `find({ value: { $gte: 2 } })` dialect is a **client-side** translation onto the tagged
tree (operator names without the sigil; an `_id` filter becomes a `key:"instance"` leaf). The wire
never sees the dialect, so a second client dialect maps onto the same tree without touching the wire.

## 5. Addressing — keys, paths, and value projection

### 5.1 Keys

A key is the couple `(instance, concept)`:

```jsonc
"key": { "instance": "550e8400-e29b-41d4-a716-446655440000", "concept": "Graph::Vertex" }
```

`instance` is a UUID (the entity identity); `concept` is the qualified concept name. The `keyType`
comes from the attachment, never the wire. A hierarchical key is an array of such segments.

**Un-projection.** The runtime renders an embedded key as `[instanceHex, conceptRuntimeIdHex]`. The
gateway un-projects every key that leaves the server — row keys, embedded key fields, expand outputs —
back to the human `{ instance, concept }` form, using a once-per-schema map from concept runtime id to
qualified concept name.

### 5.2 Paths

A `path` (the address a mutation verb edits into a document) is a **sequence of components**, each a
`{ "type": …, "value": … }` pair: `type` names the kind of step, `value` is the JSON literal that
parameterizes it. The canonical form is the component array:

```jsonc
"path": [
  { "type": "Field", "value": "materialAssignments" },
  { "type": "Key",   "value": { "instance": "…", "concept": "Surface::Material" } },
  { "type": "Field", "value": "color" }
]
```

| `type` | `value` | Step |
|--------|---------|------|
| `Field` | a string — the field name | a record/struct field |
| `Index` | an unsigned integer | a vector position |
| `Key` | the map's key, projected as its own literal (**any** type, per §5.3) | a map entry, by key |
| `Position` | a UUID string | a stable position in an `XArray` |
| `Entry` | the entry value | a set/map entry edit (non-regular) |
| `Element` | an unsigned integer | a set element (non-regular) |
| `Unwrap` | *omitted* | step into an `Optional` |

**Dotted sugar.** Where a path runs through `Field`s, `Index`es, and string `Key`s only, a client MAY
send the compact JSONPath-style string instead — the *singular*, no-wildcard form that names exactly
one node — which the gateway expands to the array:

```jsonc
"path": "a.b[0].c"   ≡   [ {"type":"Field","value":"a"}, {"type":"Field","value":"b"},
                           {"type":"Index","value":0}, {"type":"Field","value":"c"} ]
```

The string form addresses pure JSON — object members and array indices — so it expresses exactly
`Field`, `Index`, and a string `Key`, and nothing past that. No wildcards, slices, or filters: those
are *query* (the `where` selector), never a mutation path. The **component-array form is required**
wherever the address is not projection-faithful: a **typed `Key`** (a structured, non-string key), an
**XArray `Position`** (a UUID, not an ordinal), an `Entry` / `Element` / `Unwrap`, or any field name
that itself contains a `.` or `[`.

### 5.3 Value projection — how a typed value appears as a JSON literal

A document crosses the wire as a JSON literal with its *type* dropped (the one law, §0) and restored
on arrival from the schema. The projection is lossy exactly where the runtime out-expresses JSON, so a
client serializing or reading a document needs the shape of each case:

| Typed value | JSON literal |
|-------------|--------------|
| any integer / float / double | a `number` (the schema picks the exact numeric type back) |
| `Structure` (a record) | a JSON `object` — string field names |
| `Set` / `Vector` / `Tuple` | an `array` |
| `Map` (any key type) | an `array` of `[key, value]` pairs — **always**, even for string keys (see below) |
| `Variant` (a sum) | a tagged `{ "type": "<case>", "value": … }` |
| `Optional` | `null` when absent |
| `Blob` (inline bytes) | a base64 string |
| `Key` | `{ "instance": "<uuid>", "concept": "<name>" }` (§5.1) |
| `XArray` | an `array` (the stable positions travel apart, not inline) |
| `Enumeration` | the case-name string |
| `Vec` / `Mat` | an `array` of numbers |
| `UUId` / `CommitId` / `BlobId` | a hex string |

**The `Map` case, precisely.** A map projects to `[ [k, v], … ]` — an array of two-element arrays —
**with no special case for string keys**. Position 0 is the key projected as its own literal, which
may be *any* JSON value; that is exactly why an entry is a pair-array and not an object field, since a
JSON object key must be a string. Only a `Structure` (a record, with fixed string field names) stays a
JSON object — the object-vs-pairs split tracks **record vs. map**. This is also the shape JavaScript
needs: `JSON.stringify(new Map())` drops entries, so a JS `Map` serializes as `[...map]` = `[[k,v],…]`
and rebuilds with `new Map(pairs)`. So **typed map ↔ wire `[[k,v],…]` ↔ JS `Map`** throughout.

## 6. The commit & divergence model

A `CommitDatabase` is a DAG, not a mutable table. The runtime gives **convergence**; it does **not**
give a collaboration protocol, and the gateway adds none.

- A write is **base-pinned** and returns a new commit id (a receipt, like a content hash). It is a
  new commit, not an in-place mutation — the prior state stays readable (time-travel).
- Two clients writing on the same base produce **divergent heads**. The gateway never merges
  silently. **Divergence is detected client-side** (compare `heads()`); reconciliation is the
  client's explicit choice over the verbatim primitives.
- Reconciliation has no transparent "just works" form, and the surface is honest about it:
  `merge_commit` is order-dependent (gate with `is_mergeable`); `reduce_heads` converges to a single
  head **deterministically but not predictably**; a rebase re-applies intent on the new head.
- "Finding your branch" is a client convention — the runtime tracks no ownership of heads (the commit
  header has no author field; encode it in the `label`). The client remembers the commit ids it
  produced.

## 7. The client store (2b)

The store is the redux-style application model, reimplemented in the host language on top of the
basic client (2a) — the over-the-wire dual of the runtime's in-process store. It holds the current
head and an undo stack client-side; every transition is asynchronous (a wire round-trip).

| Concept | Store idiom (JavaScript) |
|---------|--------------------------|
| apply a mutation | `await store.dispatch(action)` — action creators `actions.set/update/…` |
| current state | `store.getState()` + `store.find(filter)` (the document-store read) |
| react to change | `store.subscribe(listener)` — fed by a push channel (the state-changed notification) |
| undo / redo | `await store.undo()` / `redo()` — the stack is client state; the action is a wire `disable`/`enable` commit |
| reconcile | `await store.reduceHeads()` / `merge(id)` / `forward()` |

The headline for an app developer: **redux, where the reducer is persistent, versioned, and
asynchronous** — the reducer is the commit (content-addressed, with history and non-destructive undo).

## 8. Design decisions (locked)

- **Gateway = faithful projection of the `CommitDatabase` interface.** No coordination layer, no
  auto-merge, no "smart" session. The application model lives in the client.
- **Stateless reads/writes.** The client supplies `view`/`base` on every call; the client store holds
  the head. Only cursors and blob streams are server-held resources.
- **No gateway snapshot cache.** A `CommitState` already caches the documents it materializes; a
  cursor keeps its snapshot warm across pages. A global snapshot cache (with its eviction policy) buys
  little at the targeted scale (thousands of documents) and is deliberately omitted.
- **The wire is persona-neutral and server-trivial** (the tagged predicate tree); dialects translate
  client-side.
- **Errors propagate into the response** (`{ ok:false, code, message }`); the structured code is the
  contract.
- **`delete` / `reset` are not on the wire** — destructive history rewrites are out of scope.

## 9. Status

A prototype, proven end-to-end over real HTTP. All three layers are built and tested.

- **Gateway (layer 1) — built.** `server/app.py` realizes the full wire column (§3): schema,
  read/query with key-pushdown and cursors, the eleven-verb commit envelope, the commit DAG,
  located errors, one-handle-per-session with a database catalog (`databases` / `connect`), and the
  blob JSON plane. Supported by `server/source.py` (the lazy row source), `server/query.py` (the
  tagged-tree → lazy-chain compiler), and `server/unproject.py` (embedded-key un-projection).
- **Basic client (layer 2a) — built.** `clients/js/client.mjs` — the wire ops as idiomatic async
  JavaScript (ESM, zero deps, Node 18+ and the browser).
- **Store + dialect (layer 2b) — built.** `clients/js/store.mjs` (the redux-style CommitStore:
  dispatch, subscribe, non-destructive undo/redo, divergence handling) over
  `clients/js/mongo.mjs` (the Mongo read/update dialect → the neutral wire).
- **Tests.** `tests/server/` exercises the gateway in-process; `tests/clients/js/` drives the SDK
  against a real HTTP gateway. `run_tests.sh` runs every suite.
- **Deferred.** The raw-binary blob HTTP routes (a transport optimisation over the base64 JSON
  plane), live multi-client push (a WebSocket fed by the runtime's change notifier), session
  idle-timeout, and a typed (generated) client.
