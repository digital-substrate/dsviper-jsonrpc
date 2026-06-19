#!/bin/sh
# Run the animation against a freshly-built throwaway fixture -- no ge-py needed, just proves the
# commits flow end-to-end. For the visual demo (watch it in ge-py), follow README.md.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
python3 "$DIR/../../tests/fixtures/graph_fixture.py" "$TMP/scene.graph"

lsof -ti:8787 2>/dev/null | xargs kill 2>/dev/null || true
GATEWAY_DB_DIR="$TMP" python3 "$DIR/../../server/app.py" >"$TMP/gw.log" 2>&1 &
GW=$!
trap 'kill $GW 2>/dev/null; rm -rf "$TMP"' EXIT

curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null \
  -X POST http://127.0.0.1:8787/execute -H 'Content-Type: application/json' -d '{"op":"databases"}'

node "$DIR/animate.mjs" scene.graph "${1:-12}"
