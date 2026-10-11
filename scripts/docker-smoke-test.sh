#!/usr/bin/env bash
# End-to-end smoke test: build the image, mount sample-data, convert a PDF
# over the MCP stdio transport, assert the output looks right.
#
# The script is also sourceable (scripts/docker-smoke-test.test.sh does so) to
# test wait_for_response without Docker.
set -euo pipefail

# wait_for_response ID TIMEOUT_SECONDS
# Reads newline-delimited JSON from stdin and echoes every line until the
# JSON-RPC message with "id":ID arrives.
# Returns 0 when it arrived, 1 on timeout, 2 when stdin closed before it arrived.
# A partial line that was interrupted by the one-second poll is kept and joined
# with the rest of the line, so a slow writer cannot split a message.
wait_for_response() {
  local id="$1" timeout="$2"
  local re="\"id\"[[:space:]]*:[[:space:]]*${id}[,}[:space:]]"
  local deadline=$((SECONDS + timeout))
  local line buffer="" status
  while ((SECONDS < deadline)); do
    status=0
    IFS= read -r -t 1 line || status=$?
    if ((status == 0)); then
      line="$buffer$line"
      buffer=""
      printf '%s\n' "$line"
      if [[ $line =~ $re ]]; then
        return 0
      fi
    elif ((status > 128)); then
      # Poll timed out; read leaves any partial line in $line.
      buffer="$buffer$line"
    else
      # EOF. Emit a final unterminated line, if any.
      line="$buffer$line"
      if [[ -n $line ]]; then
        printf '%s\n' "$line"
        if [[ $line =~ $re ]]; then
          return 0
        fi
      fi
      return 2
    fi
  done
  [[ -z $buffer ]] || printf '%s\n' "$buffer"
  return 1
}

main() {
  cd "$(dirname "$0")/.."

  local image="${IMAGE:-markdownify-mcp:smoke}"
  local sample_dir="$PWD/src/sample-data"
  local expected_substring="Test PDF content"
  local response_timeout="${SMOKE_TIMEOUT:-60}"
  local container="markdownify-smoke-$$"

  if [[ ! -f "$sample_dir/test.pdf" ]]; then
    echo "missing $sample_dir/test.pdf" >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: both values are fixed for this run
  trap "docker rm -f '$container' >/dev/null 2>&1 || true; rm -rf '$tmp'" EXIT

  echo "==> building $image"
  if ! docker build -t "$image" . >"$tmp/build.log" 2>&1; then
    cat "$tmp/build.log" >&2
    echo "FAIL: docker build failed" >&2
    exit 1
  fi

  echo "==> running pdf-to-markdown via stdio (waiting up to ${response_timeout}s for id 2)"
  # The container's stdin must stay open until the response arrives, otherwise
  # the server may exit on EOF before it answers. The feeder therefore idles
  # until the reader below drops the "done" marker.
  {
    printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pdf-to-markdown","arguments":{"filepath":"/data/test.pdf"}}}'
    while [[ ! -e "$tmp/done" ]]; do sleep 1; done
  } | docker run --rm -i --name "$container" \
    -v "$sample_dir:/data:ro" \
    -e MD_ALLOWED_PATHS=/data \
    "$image" | {
    rc=0
    wait_for_response 2 "$response_timeout" >"$tmp/output" || rc=$?
    echo "$rc" >"$tmp/rc"
    touch "$tmp/done"
    if ((rc != 0)); then
      # Do not wait for a hung container to notice that stdin was closed.
      docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  } || true

  local output rc
  output="$(cat "$tmp/output" 2>/dev/null || true)"
  rc="$(cat "$tmp/rc" 2>/dev/null || echo 2)"

  echo "$output"

  case "$rc" in
    0) ;;
    1)
      echo "FAIL: no response to tools/call (id 2) within ${response_timeout}s; output above" >&2
      exit 1
      ;;
    *)
      echo "FAIL: container closed stdout before responding to tools/call (id 2); output above" >&2
      exit 1
      ;;
  esac

  if grep -q '"isError":true' <<<"$output"; then
    echo "FAIL: tools/call returned isError:true" >&2
    exit 1
  fi

  if ! grep -q "$expected_substring" <<<"$output"; then
    echo "FAIL: expected output to contain '$expected_substring'" >&2
    exit 1
  fi

  echo "==> PASS"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
