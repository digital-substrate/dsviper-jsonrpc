#!/bin/sh
# Run every suite: the Python server tests (PYTHONPATH=servers/python, in-process) and the JS client
# tests (each via the HTTP harness that boots a real gateway). Non-zero exit if any suite fails.
DIR="$(cd "$(dirname "$0")" && pwd)"
rc=0

echo "== server (python) =="
for t in "$DIR"/tests/server/test_*.py; do
  printf '  %-26s ' "$(basename "$t")"
  if PYTHONPATH="$DIR/servers/python:$DIR/tests/fixtures:$DIR/../dsviper-query" python3 "$t" >/tmp/gw_test.log 2>&1; then
    tail -1 /tmp/gw_test.log
  else
    echo "FAIL"; tail -6 /tmp/gw_test.log; rc=1
  fi
done


# The dialect is written twice — client-side and in the query package — so it is compared.
# No server needed: it only diffs the trees the two translators build.
echo "== dialect parity (no server) =="
printf '  %-26s ' "test_dialect_parity.mjs"
if node "$DIR/tests/clients/js/test_dialect_parity.mjs" >/tmp/js_test.log 2>&1; then
  grep -E 'PASS [0-9]' /tmp/js_test.log | tail -1
else
  echo "FAIL"; tail -8 /tmp/js_test.log; rc=1
fi

# The client suite is the wire contract: run it against EVERY server implementation.
for impl in python node; do
  echo "== client (js, real HTTP) -> server: $impl =="
  for t in test_client.mjs test_store.mjs; do
    printf '  %-26s ' "$t"
    if JSONRPC_SERVER="$impl" sh "$DIR/tests/clients/js/run.sh" "$t" >/tmp/js_test.log 2>&1; then
      grep -E 'PASS [0-9]' /tmp/js_test.log | tail -1
    else
      echo "FAIL"; tail -8 /tmp/js_test.log; rc=1
    fi
  done
done

exit $rc
