#!/bin/sh
# Run every suite: the Python server tests (PYTHONPATH=server, in-process) and the JS client
# tests (each via the HTTP harness that boots a real gateway). Non-zero exit if any suite fails.
DIR="$(cd "$(dirname "$0")" && pwd)"
rc=0

echo "== server (python) =="
for t in "$DIR"/tests/server/test_*.py; do
  printf '  %-26s ' "$(basename "$t")"
  if PYTHONPATH="$DIR/server:$DIR/tests/fixtures" python3 "$t" >/tmp/gw_test.log 2>&1; then
    tail -1 /tmp/gw_test.log
  else
    echo "FAIL"; tail -6 /tmp/gw_test.log; rc=1
  fi
done

echo "== client (js, real HTTP) =="
for t in test_client.mjs test_store.mjs; do
  printf '  %-26s ' "$t"
  if sh "$DIR/tests/clients/js/run.sh" "$t" >/tmp/js_test.log 2>&1; then
    grep -E 'PASS [0-9]' /tmp/js_test.log | tail -1
  else
    echo "FAIL"; tail -8 /tmp/js_test.log; rc=1
  fi
done

exit $rc
