# Node server

The Node implementation of the dsviper-jsonrpc server: the same wire as the Python
server in `server/`, over the [N_Viper](https://www.npmjs.com/package/@digitalsubstrate/dsviper)
binding instead of the Python one. A client cannot tell the two apart — that is the point.

## Run

```sh
npm install
GATEWAY_DB_DIR=/path/to/databases node app.mjs     # a directory catalog (show dbs / use)
GATEWAY_DB=/path/to/a.graph      node app.mjs      # a single database, connected by default
node app.mjs                                       # an in-memory database
```

Listens on `http://127.0.0.1:8787/execute`. Requirements: Node >= 18.

## Modules

Mirrors the Python server one-to-one:

| Module          | Role                                                        |
|-----------------|-------------------------------------------------------------|
| `app.mjs`       | `Gateway` (the ops) + sessions + catalogs + the HTTP server  |
| `query.mjs`     | tagged-tree query AST -> a lazy chain over the row source     |
| `source.mjs`    | the lazy `[key, document]` row source                        |
| `unproject.mjs` | embedded-key un-projection -> `{instance, concept}`          |

## Deliberate differences from the Python server

Behaviour on the wire is identical; these are the places where matching the wire
required *not* matching the code.

- **No per-session lock.** Python serves each request on its own thread
  (`ThreadingHTTPServer`) and locks the session. Here the event loop already
  serialises requests and every binding call is synchronous, so the handler *is* the
  critical section. Note the consequence: a long call blocks the whole server.
- **Explicit value semantics in the predicate engine.** Python's `==` and `<` already
  dispatch to a value's own relations; JavaScript's `===` compares objects by reference
  and has no operator overloading. Equality and ordering therefore go through two
  primitives modelled on the `dsviper-query` / `@digitalsubstrate/dsviper-query`
  packages: duck-typed on the runtime's total `.equals()` / `.compare()` for a wrapped
  value, native otherwise. Documents are dumped to JSON before the predicate runs, so
  the native branch is the one that executes today.
  The native fallback is a *structural* comparison rather than those packages'
  `canonicalKey` token, which folds every non-scalar to `'obj:' + String(value)` and
  would make `{a: 1}` and `{b: 2}` compare equal — it exists to key a `Map`/`Set` on
  scalars and wrapped values, and the wire carries decoded JSON containers.
- **Nils sort last, and never match an order comparison.** A missing or null field
  sorts after every present value (a total order that cannot fail), while `>`, `>=`,
  `<` and `<=` require the field to be present — so `value > 5` excludes a document
  without the field instead of treating its absence as a large value. Python raises on
  a heterogeneous or null comparison instead.
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
