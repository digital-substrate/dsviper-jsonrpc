#!/bin/sh
# Integration harness: build a fixture database, start the server on a temp catalog over it, run
# the JS client test against it over real HTTP, then stop the server.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
python3 "$DIR/../../fixtures/graph_fixture.py" "$TMP/a.graph"

lsof -ti:8787 2>/dev/null | xargs kill 2>/dev/null || true
# Same wire, either implementation: JSONRPC_SERVER=python (default) or node.
if [ "${JSONRPC_SERVER:-python}" = "node" ]; then
  GATEWAY_DB_DIR="$TMP" node "$DIR/../../../servers/node/app.mjs" >"$TMP/gw.log" 2>&1 &
else
  GATEWAY_DB_DIR="$TMP" PYTHONPATH="$DIR/../../../../dsviper-query" python3 "$DIR/../../../servers/python/app.py" >"$TMP/gw.log" 2>&1 &
fi
GW=$!
trap 'kill $GW 2>/dev/null; rm -rf "$TMP"' EXIT

# wait for readiness (curl retries on connection-refused)
curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null \
  -X POST http://127.0.0.1:8787/execute -H 'Content-Type: application/json' -d '{"op":"databases"}'

node "$DIR/${1:-test_client.mjs}"
