#!/bin/sh
# Selects the server mode: no argument or "remote" runs the HTTP service, "stdio" runs the local stdio
# MCP server (use `docker run -i --rm`; stdout carries the protocol). Anything else is run as a command.
set -e
case "${1:-remote}" in
  remote) exec node dist/remote/index.js ;;
  stdio) exec node dist/index.js ;;
  *) exec "$@" ;;
esac
