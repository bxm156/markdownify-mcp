#!/usr/bin/env bash
# Docker-free test of wait_for_response from docker-smoke-test.sh.
set -euo pipefail

# shellcheck source-path=SCRIPTDIR source=docker-smoke-test.sh
source "$(dirname "$0")/docker-smoke-test.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 1. Response arrives after unrelated messages: stops at id 2, ignores later output.
rc=0
out="$(wait_for_response 2 10 <<'CANNED'
{"jsonrpc":"2.0","method":"notifications/message","params":{"id":20}}
{"jsonrpc":"2.0","id":1,"result":{}}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Test PDF content"}]}}
{"jsonrpc":"2.0","id":3,"result":{}}
CANNED
)" || rc=$?
[[ $rc -eq 0 ]] || fail "canned response: expected rc 0, got $rc"
grep -q 'Test PDF content' <<<"$out" || fail "canned response: result missing from output"
grep -q '"id":3' <<<"$out" && fail "canned response: read past the id 2 response"
grep -q '"id":1' <<<"$out" || fail "canned response: earlier output not captured"

# 2. Ids that merely start with 2 must not match.
rc=0
out="$(wait_for_response 2 10 <<<'{"jsonrpc":"2.0","id":21,"result":{}}')" || rc=$?
[[ $rc -eq 2 ]] || fail "id 21: expected rc 2 (EOF), got $rc"

# 3. EOF without the response.
rc=0
out="$(printf '{"jsonrpc":"2.0","id":1,"result":{}}\n' | wait_for_response 2 10)" || rc=$?
[[ $rc -eq 2 ]] || fail "EOF: expected rc 2, got $rc"
grep -q '"id":1' <<<"$out" || fail "EOF: captured output missing"

# 4. Final response without a trailing newline.
rc=0
out="$(printf '{"jsonrpc":"2.0","id":2,"result":{}}' | wait_for_response 2 10)" || rc=$?
[[ $rc -eq 0 ]] || fail "no trailing newline: expected rc 0, got $rc"

# 5. Timeout while the writer stays silent (and stdin stays open). The writer is
# deliberately slower than the timeout, so measure inside the reader rather than
# around the pipeline, which waits for the writer to finish.
result="$({ echo '{"jsonrpc":"2.0","id":1,"result":{}}'; sleep 6; } | {
  start=$SECONDS
  rc=0
  wait_for_response 2 2 >/dev/null || rc=$?
  echo "$rc $((SECONDS - start))"
})"
[[ ${result%% *} -eq 1 ]] || fail "timeout: expected rc 1, got '$result'"
((${result##* } < 5)) || fail "timeout: took ${result##* }s, expected about 2s"

# 6. A line split across the one-second poll is reassembled.
rc=0
out="$({ printf '{"jsonrpc":"2.0","id":'; sleep 2; printf '2,"result":{}}\n'; } | wait_for_response 2 10)" || rc=$?
[[ $rc -eq 0 ]] || fail "split line: expected rc 0, got $rc"
grep -q '^{"jsonrpc":"2.0","id":2,"result":{}}$' <<<"$out" || fail "split line: not reassembled: $out"

echo "wait_for_response tests passed"
