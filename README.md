# dsviper-jsonrpc

Drive a Viper `CommitDatabase` from any language over JSON. A thin **server** projects the
`CommitDatabase` interface onto a neutral JSON wire; **clients** speak it with familiar idioms —
Mongo-style reads, a redux-style store, undo/redo, commit history — **with no native binding**.
A JavaScript SDK is included and runs in Node and the browser.

The deliverable is the **wire**, not any one server: two implementations sit behind it, in Python
and in Node, and the client suite runs against both on every test run. A client cannot tell them
apart — that is what makes the contract a contract rather than a description of one program.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the layered design and the normative wire contract.

```
dev writes Mongo/redux JS
  → CommitStore (client) → basic client → HTTP → server → CommitDatabase → back
```

## Layout

```
servers/
  python/         the Python server, over the dsviper wheel
    query.py        the query compiler (tagged-tree wire -> a lazy chain)
    unproject.py    embedded-key un-projection (runtime ids -> human {instance, concept})
    app.py          the Gateway + sessions + the database catalog + the HTTP server
  node/           the Node server, over the N_Viper binding — same wire, see its README
clients/js/     the JavaScript SDK (ESM, zero deps, Node 18+ and the browser) — see its README
  client.mjs      the basic client — the wire ops as async methods (1:1)
  store.mjs       the CommitStore — the redux-style application model
  mongo.mjs       the Mongo dialect — filter/update -> the neutral wire (client-side)
tests/
  server/         Python tests (in-process)
  clients/js/     JavaScript tests (over a real HTTP server) + the harness + the dialect gate
demos/js/       a live animation driven through the CommitStore
ARCHITECTURE.md the design + wire contract
```

Both servers build their row source and their ordering on the consumer-side query layer
([`dsviper-query`](https://github.com/digital-substrate/dsviper-query) and
[`dsviper-node-query`](https://github.com/digital-substrate/dsviper-node-query)) rather than
carrying a private copy of it.

## Run

```sh
# the server, serving a directory of databases (each addressed by file name):
GATEWAY_DB_DIR=/path/to/databases python3 servers/python/app.py     # http://127.0.0.1:8787/execute
GATEWAY_DB_DIR=/path/to/databases node servers/node/app.mjs         # the same wire, in Node

# every suite (Python in-process + the dialect gate + JS over real HTTP against BOTH servers):
sh run_tests.sh

# the live demo: see demos/js/README.md
```

## Requirements

The `dsviper` wheel (1.2.x, **LTS-format databases**) for the Python server, the
`@digitalsubstrate/dsviper` binding for the Node one, and **Node 18+** for the client (it uses
the global `fetch`). The Node server needs **Node 22+**, which its query layer requires.

Running the **test suite** additionally needs three repositories checked out as siblings:
[`dsm-samples`](https://github.com/digital-substrate/dsm-samples) (the fixtures build their
database from its `Ge/Graph.dsm` schema), and the two query packages, which are not published to
PyPI or npm yet and are therefore resolved by path. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
setup.

## Status

Prototype, proven end-to-end. Built: the query language, the server (schema / read / the
eleven-verb commit / the commit DAG / located errors / one-handle-per-session with a database
catalog / the blob plane) in **two implementations**, the basic JS client, and the CommitStore
(Mongo read + redux dispatch + faithful undo/redo + divergence handling).

**Deferred:** the raw-binary blob HTTP routes, live multi-client push (WebSocket), and session
idle-timeout.

## Runtime dependency

At runtime, this project depends on the `dsviper` Python package
(distributed on PyPI), which is **proprietary** (license expression
`LicenseRef-DigitalSubstrate-Commercial-1.2`). See
[https://pypi.org/project/dsviper/](https://pypi.org/project/dsviper/)
for the package's licensing posture and contact information.
