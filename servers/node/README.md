# Node server

The Node implementation of the dsviper-jsonrpc server: the same wire as the Python
server in `servers/python/`, over the [N_Viper](https://www.npmjs.com/package/@digitalsubstrate/dsviper)
binding instead of the Python one. A client cannot tell the two apart — that is the point.

## Run

```sh
npm install
GATEWAY_DB_DIR=/path/to/databases node app.mjs     # a directory catalog (show dbs / use)
GATEWAY_DB=/path/to/a.graph      node app.mjs      # a single database, connected by default
node app.mjs                                       # an in-memory database
```

Listens on `http://127.0.0.1:8787/execute`. Requirements: Node >= 22, and the
`dsviper-node-query` repository checked out as a sibling — the row source and the total
ordering come from that package, which is not on npm yet and is resolved by path.

## Modules

Mirrors the Python server one-to-one:

| Module          | Role                                                        |
|-----------------|-------------------------------------------------------------|
| `app.mjs`       | `Gateway` (the ops) + sessions + catalogs + the HTTP server  |
| `query.mjs`     | tagged-tree query AST -> a lazy chain over the query layer     |
| `unproject.mjs` | embedded-key un-projection -> `{instance, concept}`          |

## Deliberate differences from the Python server

Behaviour on the wire is identical; these are the places where matching the wire
required *not* matching the code.

- **No per-session lock.** Python serves each request on its own thread
  (`ThreadingHTTPServer`) and locks the session. Here the event loop already
  serialises requests and every binding call is synchronous, so the handler *is* the
  critical section. Note the consequence: a long call blocks the whole server.
- **Equality is local, ordering is not.** Ordering uses the query layer's
  `compareValues` directly, as the Python server uses `compare_values`. Equality stays
  local: the package's own equality keys on `canonicalKey`, a token that folds every
  non-scalar to `'obj:' + String(value)` — right for keying a `Map`/`Set` on scalars and
  wrapped values, wrong for the decoded JSON containers the wire carries, where it would
  make `{a: 1}` and `{b: 2}` compare equal. So `eq`/`ne`/`in`/`nin` go through a
  structural comparison, which is what Python's `==` does on the other side.
- **Order comparisons require a present field.** `>`, `>=`, `<` and `<=` exclude a
  document without the field rather than reading its absence as a large value —
  decoupled from the total order, where a nil sorts last. (Sorting itself is no longer
  a difference: both servers now call the query layer's total ordering, so a missing
  field sorts last on either one.)
- **Cursors are pulled with `next()`.** Breaking out of a `for...of` calls the
  iterator's `return()`, which closes a generator — the next page would find it
  exhausted. Python's `for`/`return` leaves the iterator resumable.
- **`Did you mean` suggestions** approximate `difflib.get_close_matches` with a
  longest-common-subsequence ratio at the same 0.6 cutoff.

## Tests

The JS client suite is the wire contract and runs against either implementation:

```sh
JSONRPC_SERVER=node sh ../../tests/clients/js/run.sh test_client.mjs
JSONRPC_SERVER=node sh ../../tests/clients/js/run.sh test_store.mjs
```

`../../run_tests.sh` runs everything, both servers included.
