# Contributing to dsviper-jsonrpc

Thanks for your interest in contributing.

## Reporting issues

Use [GitHub Issues](https://github.com/digital-substrate/dsviper-jsonrpc/issues) and pick the appropriate template (bug report or feature request).

## Submitting pull requests

1. Fork the repository and create a feature branch from `main`
2. Make your changes (see "Running locally" below)
3. Run the full suite with `sh run_tests.sh` — both the Python server tests and the JS client tests must stay green
4. Open a pull request with a clear description of what changed and why

## Running locally

Requires Python 3.10+ (with the `dsviper` and `py-linq` wheels) and Node 18+.

```bash
pip install dsviper py-linq            # the runtime binding and the query engine
```

The test suite builds its fixture database from the `Graph.dsm` schema in the
[`dsm-samples`](https://github.com/digital-substrate/dsm-samples) repository, which it expects
checked out as a **sibling directory** (`../dsm-samples`). Clone it next to this repo before
running the tests:

```bash
git clone https://github.com/digital-substrate/dsm-samples.git ../dsm-samples
sh run_tests.sh
```

To run the server by hand against your own databases:

```bash
GATEWAY_DB_DIR=/path/to/databases python3 server/app.py    # http://127.0.0.1:8787/execute
```

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the layered design and the normative wire contract.
In short:

```
server/         the Python server — a faithful JSON projection of the CommitDatabase
clients/js/     the JavaScript SDK — basic client, CommitStore, Mongo dialect (ESM, zero deps)
tests/          server tests (in-process) and client tests (over a real HTTP server)
demos/js/       a live animation driven through the CommitStore
```

The server and the clients communicate only through the neutral JSON wire; keep that boundary
faithful to the `CommitDatabase` interface — no client-side state leaks into the wire.

## License

This project is licensed under the MIT License (see [LICENSE](LICENSE)). By submitting a pull request, you agree that your contribution is provided under the same license (inbound = outbound). No CLA is required.
