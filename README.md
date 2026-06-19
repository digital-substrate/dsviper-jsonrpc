# dsviper-jsonrpc

Drive a Viper `CommitDatabase` from any language over JSON. A thin **gateway** projects the
`CommitDatabase` interface onto a neutral JSON wire; **clients** speak it with familiar idioms —
Mongo-style reads, a redux-style store, undo/redo, commit history — **with no native binding**.
A JavaScript SDK is included and runs in Node and the browser.

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the layered design and the normative wire contract.

```
dev writes Mongo/redux JS
  → CommitStore (client) → basic client → HTTP → gateway → CommitDatabase → back
```

## Layout

```
server/         the Python server — a faithful JSON projection of the CommitDatabase
  source.py       the lazy (key, document) row source (py-linq)
  query.py        the query compiler (tagged-tree wire -> py-linq chain)
  unproject.py    embedded-key un-projection (runtime ids -> human {instance, concept})
  app.py          the Gateway + sessions + the database catalog + the HTTP server
clients/js/     the JavaScript SDK (ESM, zero deps, Node 18+ and the browser)
  client.mjs      the basic client — the wire ops as async methods (1:1)
  store.mjs       the CommitStore — the redux-style application model
  mongo.mjs       the Mongo dialect — filter/update -> the neutral wire (client-side)
tests/
  server/         Python tests (in-process)
  clients/js/     JavaScript tests (over a real HTTP gateway) + the harness
demos/js/       a live animation driven through the CommitStore
ARCHITECTURE.md the design + wire contract
```

## Run

```sh
# the gateway, serving a directory of databases (each addressed by file name):
GATEWAY_DB_DIR=/path/to/databases python3 server/app.py      # http://127.0.0.1:8787/execute

# every test suite (Python in-process + JS over real HTTP):
sh run_tests.sh

# the live demo: see demos/js/README.md
```

## Requirements

The `dsviper` wheel (1.2.x, **LTS-format databases**), `py-linq` (the gateway's query engine),
and **Node 18+** (the client; it uses the global `fetch`).

Running the **test suite** additionally requires the [`dsm-samples`](https://github.com/digital-substrate/dsm-samples)
repository checked out as a sibling directory (`../dsm-samples`): the fixtures build their database
from its `Ge/Graph.dsm` schema. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup.

## Status

Prototype, proven end-to-end. Built: the query language, the gateway (schema / read / the
eleven-verb commit / the commit DAG / located errors / one-handle-per-session with a database
catalog / the blob plane), the basic JS client, and the CommitStore (Mongo read + redux dispatch +
faithful undo/redo + divergence handling). **Deferred:** the raw-binary blob HTTP routes, live
multi-client push (WebSocket), session idle-timeout, and the typed (generated) client.
