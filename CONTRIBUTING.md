# Contributing to dsviper-jsonrpc

Thanks for your interest in contributing.

## Reporting issues

Use [GitHub Issues](https://github.com/digital-substrate/dsviper-jsonrpc/issues) and pick the appropriate template (bug report or feature request).

## Submitting pull requests

1. Fork the repository and create a feature branch from `main`
2. Make your changes (see "Running locally" below)
3. Run the full suite with `sh run_tests.sh` — the Python server tests, the dialect gate, and the JS client tests against BOTH servers must stay green — and `npm run typecheck` in `servers/node`, which checks the Node server and the JS client against their declarations
4. Open a pull request with a clear description of what changed and why

## Running locally

Requires Python 3.10+ with the `dsviper` wheel, and Node 18+ for the client. The Node server
needs Node 22+, which its query layer requires.

```bash
pip install "dsviper<2"                # the runtime binding
```

The test suite builds its fixture database from the `Graph.dsm` schema in the
[`dsm-samples`](https://github.com/digital-substrate/dsm-samples) repository, which it expects
checked out as a **sibling directory** (`../dsm-samples`). Clone it next to this repo before
running the tests:

```bash
git clone https://github.com/digital-substrate/dsm-samples.git ../dsm-samples
sh run_tests.sh
```

The servers build on the consumer-side query layer, which they also expect as siblings —
[`dsviper-query`](https://github.com/digital-substrate/dsviper-query) for the Python server
and [`dsviper-node-query`](https://github.com/digital-substrate/dsviper-node-query) for the
Node one. Neither is published to PyPI or npm yet, so both are resolved by path:

```bash
git clone https://github.com/digital-substrate/dsviper-query.git ../dsviper-query
git clone https://github.com/digital-substrate/dsviper-node-query.git ../dsviper-node-query
(cd servers/node && npm install)
```

To run the server by hand against your own databases:

```bash
GATEWAY_DB_DIR=/path/to/databases python3 servers/python/app.py    # http://127.0.0.1:8787/execute
```

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the layered design and the normative wire contract.
In short:

```
servers/python/ the Python server — a faithful JSON projection of the CommitDatabase
servers/node/   the Node server — the same wire, over the N_Viper binding
clients/js/     the JavaScript SDK — basic client, CommitStore, Mongo dialect (ESM, zero deps)
tests/          server tests (in-process) and client tests (over a real HTTP server)
demos/js/       a live animation driven through the CommitStore
```

The servers and the clients communicate only through the neutral JSON wire; keep that boundary
faithful to the `CommitDatabase` interface — no client-side state leaks into the wire.

**A change to the wire is a change to two servers.** Whichever you touch, the other must follow:
`run_tests.sh` runs the client suite against both, and a wire that only one of them honours is a
wire that has stopped being a contract.

## License

This project is licensed under the MIT License (see [LICENSE](LICENSE)). By submitting a pull request, you agree that your contribution is provided under the same license (inbound = outbound). No CLA is required.
