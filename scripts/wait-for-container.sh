#!/usr/bin/env bash
# Wait until a started container answers /readyz AND Docker reports its image HEALTHCHECK as healthy.
# Usage: scripts/wait-for-container.sh <container> [base-url] [timeout-seconds]
# On failure prints the health log and container logs, then exits 1.
set -euo pipefail

name="${1:?usage: wait-for-container.sh <container> [base-url] [timeout-seconds]}"
base="${2:-http://localhost:8000}"
timeout="${3:-90}"
deadline=$((SECONDS + timeout))
ready=0
health=unknown

while [ "$SECONDS" -lt "$deadline" ]; do
  if [ "$ready" -eq 0 ] && curl --fail --silent --max-time 1 "$base/readyz" >/dev/null; then
    ready=1
  fi
  if ! state="$(docker inspect -f '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null)"; then
    echo "container $name not found" >&2
    exit 1
  fi
  running="${state%% *}"
  health="${state#* }"
  if [ "$running" != true ]; then
    echo "container $name exited before becoming healthy" >&2
    break
  fi
  case "$health" in
    none) echo "container $name has no HEALTHCHECK" >&2; break ;;
    unhealthy) echo "container $name reported unhealthy" >&2; break ;;
    healthy)
      if [ "$ready" -eq 1 ]; then
        echo "container $name ready and healthy"
        exit 0
      fi
      ;;
  esac
  sleep 1
done

echo "container $name did not become ready and healthy (ready=$ready health=$health timeout=${timeout}s)" >&2
docker inspect -f '{{json .State.Health}}' "$name" >&2 || true
docker logs "$name" >&2 || true
exit 1
