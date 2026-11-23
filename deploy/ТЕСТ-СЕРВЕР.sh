#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/test-server.sh" "$@"
